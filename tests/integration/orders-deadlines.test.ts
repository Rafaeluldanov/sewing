/**
 * Integration-тесты управленческого слоя «Order Deadlines + Risk
 * Detection» (см. ТЗ + `@sewing/shared/order-deadlines`).
 *
 * Сценарии:
 *   1. POST /api/orders с `dueDate` в прошлом → list + detail отдают
 *      `deadline.status = OVERDUE`, `tone = danger`, `daysLeft < 0`.
 *   2. POST /api/orders с `dueDate = завтра` без выпуска → AT_RISK.
 *   3. PACKED-паспорта учитываются как `qtyFinished` и двигают
 *      `deadline.progressPercent`; высокий процент уводит из AT_RISK
 *      в ON_TRACK.
 *   4. Фильтр `?deadline=OVERDUE` возвращает только просроченные.
 *   5. Фильтр `?clientId=…` фильтрует по карточке клиента.
 *   6. Без `dueDate` → `NO_DUE_DATE`, и список этих заказов отдельно
 *      доступен через `?deadline=NO_DUE_DATE`.
 *   7. Завершённый заказ (status=DONE) НЕ попадает в OVERDUE-бакет
 *      даже если dueDate в прошлом.
 *
 * Бэкенд считает все бакеты через общий `evaluateOrderDeadline`,
 * фильтрация и пагинация — в `OrdersService.list` (см. комментарий
 * `useDeadlineFilter`).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — orders deadline / risk detection', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookie: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookie = loginAs(t, seed.employees['shop-chief']);
  });

  /**
   * ISO-дата без времени (yyyy-mm-dd) от сдвига `daysFromToday` в днях.
   * Используем UTC, чтобы тест был стабильным независимо от TZ хоста и
   * совпадал с `evaluateOrderDeadline` (UTC-сравнение календарного дня).
   */
  function dueDate(daysFromToday: number): string {
    const today = new Date();
    const d = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    d.setUTCDate(d.getUTCDate() + daysFromToday);
    return d.toISOString().slice(0, 10);
  }

  async function createOrderViaApi(opts: {
    dueDate?: string | null;
    qtyPlan?: number;
    sizeId?: string;
    clientId?: string | null;
  }): Promise<{ id: string; number: string }> {
    const body: Record<string, unknown> = {
      orderDate: new Date().toISOString(),
      productId: seed.product.id,
      items: [
        {
          sizeId: opts.sizeId ?? seed.sizes.M,
          qtyPlan: opts.qtyPlan ?? 10,
        },
      ],
    };
    if (opts.dueDate !== undefined) body.dueDate = opts.dueDate;
    if (opts.clientId !== undefined) body.clientId = opts.clientId;
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send(body);
    expect(res.status).toBe(201);
    return { id: res.body.id, number: res.body.number };
  }

  /** Перевод заказа в IN_PRODUCTION прямо в БД, чтобы не дёргать
   *  routes/snapshot из боевого `start()` — нам важен только статус. */
  async function setOrderInProduction(orderId: string) {
    await t.prisma.order.update({
      where: { id: orderId },
      data: { status: 'IN_PRODUCTION' },
    });
  }

  // ---------------------------------------------------------------------------
  // 1. OVERDUE
  // ---------------------------------------------------------------------------

  test('заказ с dueDate в прошлом → list + detail возвращают deadline.status=OVERDUE', async () => {
    const o = await createOrderViaApi({ dueDate: dueDate(-3) });
    await setOrderInProduction(o.id);

    const list = await request(t.app.getHttpServer())
      .get('/api/orders')
      .set('Cookie', cookie);
    expect(list.status).toBe(200);
    const item = list.body.items.find((x: { id: string }) => x.id === o.id);
    expect(item).toBeDefined();
    expect(item.deadline.status).toBe('OVERDUE');
    expect(item.deadline.tone).toBe('danger');
    expect(item.deadline.label).toBe('Просрочен');
    expect(item.deadline.daysLeft).toBe(-3);

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${o.id}`)
      .set('Cookie', cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.deadline.status).toBe('OVERDUE');
    expect(detail.body.qtyFinishedTotal).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 2. AT_RISK
  // ---------------------------------------------------------------------------

  test('заказ dueDate = завтра без выпуска → AT_RISK (warning)', async () => {
    const o = await createOrderViaApi({ dueDate: dueDate(1), qtyPlan: 10 });
    await setOrderInProduction(o.id);

    const list = await request(t.app.getHttpServer())
      .get('/api/orders')
      .set('Cookie', cookie);
    const item = list.body.items.find((x: { id: string }) => x.id === o.id);
    expect(item.deadline.status).toBe('AT_RISK');
    expect(item.deadline.tone).toBe('warning');
    expect(item.deadline.daysLeft).toBe(1);
    expect(item.deadline.progressPercent).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 3. PACKED-паспорта влияют на progressPercent → ON_TRACK
  // ---------------------------------------------------------------------------

  test('PACKED-паспорта поднимают progressPercent и могут перевести AT_RISK → ON_TRACK', async () => {
    const o = await createOrderViaApi({ dueDate: dueDate(1), qtyPlan: 10 });
    await setOrderInProduction(o.id);

    // Создаём 1 PACKED-паспорт с qtyGood = 9 (= 90% выпуска).
    // Сравнение прогресса в evaluateOrderDeadline идёт по `qtyFinished`,
    // который backend считает Σ Passport.qtyGood для PACKED-паспортов
    // (см. `OrdersService.toListItemDto` и `aggregateOrder`).
    await t.prisma.passport.create({
      data: {
        number: 'P-DEADLINE-1',
        qrCode: 'passport:deadline-1',
        orderId: o.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Белая',
        rollNumber: 'R-DL-1',
        cutDate: new Date(),
        qtyPlan: 10,
        qtyCut: 10,
        qtyGood: 9,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'PACKED',
      },
    });

    const list = await request(t.app.getHttpServer())
      .get('/api/orders')
      .set('Cookie', cookie);
    const item = list.body.items.find((x: { id: string }) => x.id === o.id);
    expect(item.qtyFinishedTotal).toBe(9);
    expect(item.deadline.progressPercent).toBe(90);
    // 90% > 80% → AT_RISK снимается.
    expect(item.deadline.status).toBe('ON_TRACK');
    expect(item.deadline.tone).toBe('success');

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${o.id}`)
      .set('Cookie', cookie);
    expect(detail.body.qtyFinishedTotal).toBe(9);
    expect(detail.body.deadline.progressPercent).toBe(90);
    expect(detail.body.deadline.status).toBe('ON_TRACK');
  });

  // ---------------------------------------------------------------------------
  // 4. Filter ?deadline=OVERDUE
  // ---------------------------------------------------------------------------

  test('GET /api/orders?deadline=OVERDUE возвращает только просроченные', async () => {
    const overdue = await createOrderViaApi({ dueDate: dueDate(-2) });
    await setOrderInProduction(overdue.id);
    const onTrack = await createOrderViaApi({ dueDate: dueDate(10) });
    await setOrderInProduction(onTrack.id);
    const noDue = await createOrderViaApi({ dueDate: null });
    await setOrderInProduction(noDue.id);

    const res = await request(t.app.getHttpServer())
      .get('/api/orders?deadline=OVERDUE')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((x: { id: string }) => x.id);
    expect(ids).toContain(overdue.id);
    expect(ids).not.toContain(onTrack.id);
    expect(ids).not.toContain(noDue.id);
    // total в ответе тоже считается на отфильтрованной выборке.
    expect(res.body.total).toBe(1);

    const noDueRes = await request(t.app.getHttpServer())
      .get('/api/orders?deadline=NO_DUE_DATE')
      .set('Cookie', cookie);
    expect(noDueRes.status).toBe(200);
    const noDueIds = noDueRes.body.items.map((x: { id: string }) => x.id);
    expect(noDueIds).toContain(noDue.id);
    expect(noDueIds).not.toContain(overdue.id);
  });

  // ---------------------------------------------------------------------------
  // 5. Filter ?clientId=…
  // ---------------------------------------------------------------------------

  test('GET /api/orders?clientId=… отдаёт только заказы этого клиента', async () => {
    const client = await t.prisma.client.create({
      data: { name: 'ИП Тестов', isActive: true },
    });
    const own = await createOrderViaApi({
      dueDate: dueDate(5),
      clientId: client.id,
    });
    const foreign = await createOrderViaApi({ dueDate: dueDate(5) });

    const res = await request(t.app.getHttpServer())
      .get(`/api/orders?clientId=${client.id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((x: { id: string }) => x.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(foreign.id);
  });

  // ---------------------------------------------------------------------------
  // 6. NO_DUE_DATE
  // ---------------------------------------------------------------------------

  test('заказ без dueDate → deadline.status = NO_DUE_DATE', async () => {
    const o = await createOrderViaApi({ dueDate: null });
    await setOrderInProduction(o.id);

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${o.id}`)
      .set('Cookie', cookie);
    expect(detail.body.deadline.status).toBe('NO_DUE_DATE');
    expect(detail.body.deadline.tone).toBe('muted');
    expect(detail.body.deadline.daysLeft).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 7. DONE-заказ не попадает в OVERDUE
  // ---------------------------------------------------------------------------

  test('завершённый заказ не помечается OVERDUE, даже если dueDate в прошлом', async () => {
    const o = await createOrderViaApi({ dueDate: dueDate(-10) });
    await t.prisma.order.update({
      where: { id: o.id },
      data: { status: 'DONE' },
    });

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${o.id}`)
      .set('Cookie', cookie);
    expect(detail.body.status).toBe('DONE');
    expect(detail.body.deadline.status).toBe('DONE');
    expect(detail.body.deadline.label).toBe('Готов');

    const overdueOnly = await request(t.app.getHttpServer())
      .get('/api/orders?deadline=OVERDUE')
      .set('Cookie', cookie);
    const ids = overdueOnly.body.items.map((x: { id: string }) => x.id);
    expect(ids).not.toContain(o.id);
  });
});
