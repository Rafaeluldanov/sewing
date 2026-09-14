/**
 * Забытый таймер подкроя (`RecutSession`) — регрессия на находку G4-3
 * Аудита движка расчёта 13.09.2026 (сестра K7 — предохранитель на часы
 * смены, см. `salary.test.ts`) в редакции ревью.
 *
 * Было: забытый таймер тикал до следующей смены, при «Завершить подкрой»
 * в понедельник `workedSeconds = 65 ч`, доплата 19 500 ₽ уходила в
 * ведомость (`RECUT`) и в `recut_rub` документа выпуска для ERP.
 *
 * Первая починка резала конец подкроя концом смены и завершала подкрой
 * при `stop` смены — это вариант «жёсткая граница сменой» из решения №12
 * списка решений владельца («жёсткая граница или предупреждение
 * мастеру»), которое владелец НЕ принимал (ревью G4-3). Поэтому теперь:
 *   1. закрытие смены (`ShiftsService.stop`, в т. ч. мастером) подкрой НЕ
 *      завершает, «Завершить подкрой» ставит `endedAt` моментом нажатия;
 *   2. в деньгах работает только предохранитель K7: подкрой не длиннее
 *      предела на смену (16 ч по умолчанию / `shiftMaxDurationHours`);
 *   3. вместо границы — ПРЕДУПРЕЖДЕНИЕ: `longerThanShift` /
 *      `cappedByGuard` в DTO подкроя, `activeRecutOverLimit` у мастера,
 *      пометка в `managerComment` строки `RECUT` ведомости.
 *
 * Техника: `startedAt` смены/сегмента/подкроя бэкдейтятся через prisma
 * (в БД `@default(now())`), моменты «пт 18:00» / «пн 09:00» задаются
 * `vi.useFakeTimers({ toFake: ['Date'] })` только на время HTTP-вызова.
 * «Понедельник 09:00» = ближайшее 09:00 UTC в прошлом: пятничные моменты
 * ложатся в один UTC-день (контейнер в UTC, `startOfDay` локальный), а
 * cookie (exp = real now + 1h) остаётся валидной при фейковом now ≤ real.
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { loginAs, refreshAdminCookie, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';
import { OrderFactCostService } from '../../apps/api/src/modules/costs/order-fact-cost.service.js';
import { PassportRealCostService } from '../../apps/api/src/modules/costs/passport-real-cost.service.js';
import { OrderMaterialCostService } from '../../apps/api/src/modules/costs/order-material-cost.service.js';

const H = 3600 * 1000;

/** Ближайшее 09:00 UTC, не позже реального now. */
function anchor09(): Date {
  const d = new Date();
  d.setUTCHours(9, 0, 0, 0);
  if (d.getTime() > Date.now()) d.setTime(d.getTime() - 24 * H);
  return d;
}

describeWithDb('забытый подкрой: предохранитель + предупреждение, не граница сменой (G4-3, ревью)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    vi.useRealTimers();
    await stopTestApp(t);
  });
  beforeEach(async () => {
    vi.useRealTimers();
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    await refreshAdminCookie(t);
    // `CompanySettings` трункейтится `resetDatabase`; upsert задаёт
    // значения теста явно: автозакрытие выключено, предел по умолчанию.
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        singleton: true,
        shiftAutoCloseTime: null,
        shiftMaxDurationHours: 0,
      },
      update: { shiftAutoCloseTime: null, shiftMaxDurationHours: 0 },
    });
    // Раскройщик — MIXED с почасовой ставкой 300 ₽/ч.
    await t.prisma.employee.update({
      where: { id: seed.employees.cutter.id },
      data: {
        compensationType: 'MIXED',
        salaryRateMode: 'HOURLY',
        salaryPerHour: new Prisma.Decimal(300),
      },
    });
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      cutter: loginAs(t, seed.employees.cutter),
      master: loginAs(t, seed.employees.master),
    };
  });

  /** Закрытый ERP-заказ с двумя упакованными паспортами (4 + 6 = 10 годных). */
  async function closedOrder(specId: string, erp: { id: string; number: string }): Promise<string> {
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-09-01T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        patternItemId: specId,
        erpCustomerOrderId: erp.id,
        erpCustomerOrderNumber: erp.number,
      })
      .expect(201);
    const orderId: string = order.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    for (const [i, qty] of [4, 6].entries()) {
      const passport = await request(t.app.getHttpServer())
        .post('/api/passports')
        .set('Cookie', cookies.manager)
        .send({
          orderId,
          sizeId: seed.sizes.M,
          rollNumber: `R-G43-${erp.number}-${i}`,
          cutDate: '2026-09-01T00:00:00.000Z',
          qtyCut: qty,
          cutterId: seed.employees.cutter.id,
        })
        .expect(201);
      await t.prisma.passport.update({
        where: { id: passport.body.id },
        data: { status: 'PACKED', qtyGood: qty },
      });
    }
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    return orderId;
  }

  async function factCost(orderId: string) {
    const passports = await t.prisma.passport.findMany({
      where: { orderId, status: 'PACKED' },
      select: { qtyGood: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma = t.prisma as any;
    return new OrderFactCostService(
      prisma,
      new PassportRealCostService(prisma),
      new OrderMaterialCostService(prisma),
    ).factCostForOrder(
      orderId,
      passports.reduce((sum, p) => sum + (p.qtyGood ?? 0), 0),
    );
  }

  /** Выполнить `fn` при замороженном `Date` = `at` (только Date, таймеры Node живые). */
  async function atMoment<T>(at: Date, fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  }

  /** Смена раскройщика пт 10:00 + подкрой по заказу с пт 16:00 (бэкдейт через prisma). */
  async function fridayShiftWithRecut(orderId: string, fri10: Date, fri16: Date) {
    const eq = seed.equipment['cutting-table-01'];
    const op = seed.operations['CUT_DIVISION'];
    const shift = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.cutter)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);
    const started = await request(t.app.getHttpServer())
      .post('/api/recut/start')
      .set('Cookie', cookies.cutter)
      .send({ orderId })
      .expect(201);
    expect(started.body.status).toBe('ACTIVE');
    const shiftId: string = shift.body.id;
    const recutId: string = started.body.id;
    await t.prisma.shiftSession.update({ where: { id: shiftId }, data: { startedAt: fri10 } });
    await t.prisma.shiftSegment.updateMany({ where: { shiftSessionId: shiftId }, data: { startedAt: fri10 } });
    await t.prisma.recutSession.update({ where: { id: recutId }, data: { startedAt: fri16 } });
    const linked = await t.prisma.recutSession.findUniqueOrThrow({ where: { id: recutId } });
    expect(linked.shiftSessionId).toBe(shiftId);
    return { shiftId, recutId, eq, op };
  }

  test('«Завершить смену» подкрой НЕ завершает; «Завершить» в понедельник → оплата по предохранителю 16 ч, а не по концу смены; флаги и пометка выставлены', async () => {
    const mon09 = anchor09();
    const fri10 = new Date(mon09.getTime() - 71 * H);
    const fri16 = new Date(mon09.getTime() - 65 * H);
    const fri18 = new Date(mon09.getTime() - 63 * H);

    const spec = await createSpecPattern(t, cookies.manager, {
      materialLines: [
        { name: 'Кулирка чёрная', unit: 'кг', qtyPerUnit: '0.5', materialRole: 'MAIN_FABRIC', colorRule: 'ORDER_COLOR' },
      ],
    });
    const orderA = await closedOrder(spec.id, { id: 'erp-order-10', number: 'ФС-000010' });
    const orderB = await closedOrder(spec.id, { id: 'erp-order-11', number: 'ФС-000011' });
    expect((await factCost(orderA)).recut_rub).toBe(0);

    const { recutId, eq, op } = await fridayShiftWithRecut(orderA, fri10, fri16);

    // Пятница 18:00: «Завершить смену» — смена закрыта, подкрой остаётся
    // ACTIVE (решение №12 владельцем не принято — границы сменой нет).
    const stopped = await atMoment(fri18, () =>
      request(t.app.getHttpServer())
        .post('/api/shifts/stop')
        .set('Cookie', cookies.cutter)
        .send({})
        .expect(201),
    );
    expect(new Date(stopped.body.endedAt).getTime()).toBe(fri18.getTime());
    const afterStop = await t.prisma.recutSession.findUniqueOrThrow({ where: { id: recutId } });
    expect(afterStop.status).toBe('ACTIVE');
    expect(afterStop.endedAt).toBeNull();

    // Ведомость пятницы: SHIFT_DAY 8 ч = 2 400 ₽ без пометки (смена штатная), RECUT-строки ещё нет.
    const shiftDay = await t.prisma.salaryEntry.findFirst({
      where: { employeeId: seed.employees.cutter.id, source: 'SHIFT_DAY' },
    });
    expect(shiftDay!.workedSeconds).toBe(8 * 3600);
    expect(Number(shiftDay!.amount)).toBe(2400);
    expect(shiftDay!.managerComment).toBeNull();
    expect(
      await t.prisma.salaryEntry.findFirst({
        where: { employeeId: seed.employees.cutter.id, source: 'RECUT' },
      }),
    ).toBeNull();

    // Понедельник 09:00: новая смена; активный подкрой пережил свою смену и
    // тикает дольше предела — предупреждение раскройщику и мастеру.
    await atMoment(mon09, () =>
      request(t.app.getHttpServer())
        .post('/api/shifts/start')
        .set('Cookie', cookies.cutter)
        .send({ equipmentId: eq.id, operationId: op.id })
        .expect(201),
    );
    const active = await atMoment(mon09, () =>
      request(t.app.getHttpServer())
        .get('/api/recut/active')
        .set('Cookie', cookies.cutter)
        .expect(200),
    );
    expect(active.body.id).toBe(recutId);
    expect(active.body.status).toBe('ACTIVE');
    expect(active.body.longerThanShift).toBe(true);
    expect(active.body.cappedByGuard).toBe(true);

    const masterView = await atMoment(mon09, () =>
      request(t.app.getHttpServer())
        .get('/api/master/employee-stats/active-shifts')
        .set('Cookie', cookies.master)
        .expect(200),
    );
    const cutterRow = masterView.body.rows.find(
      (r: { employeeId: string }) => r.employeeId === seed.employees.cutter.id,
    );
    expect(cutterRow).toBeDefined();
    expect(cutterRow.hasActiveRecut).toBe(true);
    expect(cutterRow.activeRecutOverLimit).toBe(true);

    // Новый подкрой при живом старом — 409: таймер надо остановить руками.
    const second = await request(t.app.getHttpServer())
      .post('/api/recut/start')
      .set('Cookie', cookies.cutter)
      .send({ orderId: orderB });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('RECUT_ALREADY_ACTIVE');

    // «Завершить подкрой» в понедельник: endedAt = момент нажатия (не конец
    // смены), в деньгах — предохранитель 16 ч = 4 800 ₽ (не 65 ч = 19 500 и
    // не 2 ч = 600 по концу смены).
    const done = await atMoment(mon09, () =>
      request(t.app.getHttpServer())
        .post(`/api/recut/${recutId}/complete`)
        .set('Cookie', cookies.cutter)
        .send({})
        .expect(201),
    );
    const cap = 16 * 3600;
    expect(done.body.status).toBe('DONE');
    expect(new Date(done.body.endedAt).getTime()).toBe(mon09.getTime());
    expect(done.body.workedSeconds).toBe(cap);
    expect(done.body.ratePerHour).toBe(300);
    expect(done.body.amount).toBe(4800);
    expect(done.body.longerThanShift).toBe(true);
    expect(done.body.cappedByGuard).toBe(true);

    // RECUT-строка ведомости пятницы (день старта) — с пометкой.
    const recutEntry = await t.prisma.salaryEntry.findFirst({
      where: { employeeId: seed.employees.cutter.id, source: 'RECUT' },
    });
    expect(recutEntry).not.toBeNull();
    expect(recutEntry!.date.getTime()).toBe(shiftDay!.date.getTime());
    expect(recutEntry!.workedSeconds).toBe(cap);
    expect(Number(recutEntry!.amount)).toBe(4800);
    expect(recutEntry!.managerComment).toBe(
      'Подкрой длиннее смены; обрезано предохранителем 16 ч (фактически 65 ч)',
    );
    expect(recutEntry!.editedManually).toBe(false);

    // Себестоимость заказа (то, что уедет в документ выпуска / ERP): 4 800 ₽.
    expect((await factCost(orderA)).recut_rub).toBe(4800);

    // Повторное «Завершить» уже завершённого подкроя — 409, а не вторая оплата.
    const again = await request(t.app.getHttpServer())
      .post(`/api/recut/${recutId}/complete`)
      .set('Cookie', cookies.cutter)
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('RECUT_NOT_ACTIVE');
  });

  test('штатный подкрой 2 ч внутри смены: 600 ₽, без флагов и без пометки', async () => {
    const mon09 = anchor09();
    const fri10 = new Date(mon09.getTime() - 71 * H);
    const fri16 = new Date(mon09.getTime() - 65 * H);
    const fri18 = new Date(mon09.getTime() - 63 * H);

    const spec = await createSpecPattern(t, cookies.manager, {
      materialLines: [
        { name: 'Кулирка чёрная', unit: 'кг', qtyPerUnit: '0.5', materialRole: 'MAIN_FABRIC', colorRule: 'ORDER_COLOR' },
      ],
    });
    const orderA = await closedOrder(spec.id, { id: 'erp-order-12', number: 'ФС-000012' });
    const { recutId } = await fridayShiftWithRecut(orderA, fri10, fri16);

    // Живой таймер внутри открытой смены — предупреждений нет.
    const active = await atMoment(new Date(fri16.getTime() + H), () =>
      request(t.app.getHttpServer())
        .get('/api/recut/active')
        .set('Cookie', cookies.cutter)
        .expect(200),
    );
    expect(active.body.longerThanShift).toBe(false);
    expect(active.body.cappedByGuard).toBe(false);

    const done = await atMoment(fri18, () =>
      request(t.app.getHttpServer())
        .post(`/api/recut/${recutId}/complete`)
        .set('Cookie', cookies.cutter)
        .send({})
        .expect(201),
    );
    expect(done.body.status).toBe('DONE');
    expect(new Date(done.body.endedAt).getTime()).toBe(fri18.getTime());
    expect(done.body.workedSeconds).toBe(7200);
    expect(done.body.amount).toBe(600);
    expect(done.body.longerThanShift).toBe(false);
    expect(done.body.cappedByGuard).toBe(false);

    await atMoment(fri18, () =>
      request(t.app.getHttpServer())
        .post('/api/shifts/stop')
        .set('Cookie', cookies.cutter)
        .send({})
        .expect(201),
    );

    const recutEntry = await t.prisma.salaryEntry.findFirst({
      where: { employeeId: seed.employees.cutter.id, source: 'RECUT' },
    });
    expect(recutEntry!.workedSeconds).toBe(7200);
    expect(Number(recutEntry!.amount)).toBe(600);
    expect(recutEntry!.managerComment).toBeNull();
    expect((await factCost(orderA)).recut_rub).toBe(600);
  });

  test('забыли и смену, и подкрой: stop в понедельник режет часы смены (с пометкой), подкрой остаётся активным и режется при своём «Завершить»', async () => {
    const mon09 = anchor09();
    const fri10 = new Date(mon09.getTime() - 71 * H);
    const fri16 = new Date(mon09.getTime() - 65 * H);

    const spec = await createSpecPattern(t, cookies.manager, {
      materialLines: [
        { name: 'Кулирка чёрная', unit: 'кг', qtyPerUnit: '0.5', materialRole: 'MAIN_FABRIC', colorRule: 'ORDER_COLOR' },
      ],
    });
    const orderA = await closedOrder(spec.id, { id: 'erp-order-13', number: 'ФС-000013' });
    const { recutId } = await fridayShiftWithRecut(orderA, fri10, fri16);

    const stopped = await atMoment(mon09, () =>
      request(t.app.getHttpServer())
        .post('/api/shifts/stop')
        .set('Cookie', cookies.cutter)
        .send({})
        .expect(201),
    );
    expect(new Date(stopped.body.endedAt).getTime()).toBe(mon09.getTime());

    // Предохранитель K7 (`shiftMaxDurationHours = 0` → 16 ч): смена 71 ч в
    // деньгах — 16 ч = 4 800 ₽ с пометкой; сама `ShiftSession` хранит
    // настоящий `endedAt` (табель мастера).
    const cap = 16 * 3600;
    const shiftDay = await t.prisma.salaryEntry.findFirst({
      where: { employeeId: seed.employees.cutter.id, source: 'SHIFT_DAY' },
    });
    expect(shiftDay!.workedSeconds).toBe(cap);
    expect(Number(shiftDay!.amount)).toBe(4800);
    expect(shiftDay!.managerComment).toBe('Обрезано предохранителем 16 ч (фактически 71 ч)');

    // Подкрой закрытием смены не тронут.
    const stillActive = await t.prisma.recutSession.findUniqueOrThrow({ where: { id: recutId } });
    expect(stillActive.status).toBe('ACTIVE');

    // «Завершить подкрой» через полчаса после закрытия смены: 65,5 ч
    // фактически → 16 ч в деньгах, пометка «длиннее смены».
    const mon0930 = new Date(mon09.getTime() + H / 2);
    const done = await atMoment(mon0930, () =>
      request(t.app.getHttpServer())
        .post(`/api/recut/${recutId}/complete`)
        .set('Cookie', cookies.cutter)
        .send({})
        .expect(201),
    );
    expect(new Date(done.body.endedAt).getTime()).toBe(mon0930.getTime());
    expect(done.body.workedSeconds).toBe(cap);
    expect(done.body.amount).toBe(4800);
    expect(done.body.longerThanShift).toBe(true);
    expect(done.body.cappedByGuard).toBe(true);

    const recutEntry = await t.prisma.salaryEntry.findFirst({
      where: { employeeId: seed.employees.cutter.id, source: 'RECUT' },
    });
    expect(recutEntry!.workedSeconds).toBe(cap);
    expect(Number(recutEntry!.amount)).toBe(4800);
    expect(recutEntry!.managerComment).toBe(
      'Подкрой длиннее смены; обрезано предохранителем 16 ч (фактически 65,5 ч)',
    );
    expect((await factCost(orderA)).recut_rub).toBe(4800);
  });
});
