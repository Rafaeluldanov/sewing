/**
 * Integration-тесты этапа «Клиент — обязательный атрибут заказа».
 *
 * Требование: заказ всегда принадлежит карточке клиента
 * (`Order.clientId → Client`). Обязательность держат три контура (см.
 * `apps/web/lib/order-client-required.ts`):
 *   - формы web-а — `required`-селект «Клиент» без варианта «без клиента»;
 *   - server actions — гейт `clientRequiredError` (`fieldErrors.clientId`);
 *   - backend — этот файл.
 *
 * Backend-контур (`apps/api/src/common/errors.ts::OrderClientRequiredException`):
 *   1. `POST /api/orders` БЕЗ `clientId` по-прежнему 201 — ручка остаётся
 *      backward-compatible (легаси-flow, CUTTER_ASSISTANT, DRAFT-заказ из
 *      КБ-задачи). Заказ остаётся в `DRAFT`.
 *   2. `POST /api/orders/:id/start-calculation` для заказа без клиента →
 *      400 `ORDER_CLIENT_REQUIRED`; заказ остаётся в `DRAFT` (потребности
 *      цеха не создаются).
 *   3. Тот же заказ после `PATCH { clientId }` уходит в расчёт штатно.
 *   4. `PATCH { clientId: null }` (в web-формах = пустой селект) →
 *      400 `ORDER_CLIENT_REQUIRED`: клиента можно заменить, но не снять.
 *   5. Порядок гейтов: `ORDER_PATTERN_REQUIRED` остаётся раньше клиента —
 *      контракт на очерёдность ошибок формы не меняем.
 *
 * См. `docs/domain.md §«Заказ»`, `prisma/schema.prisma model Order`,
 * `tests/integration/order-calculation.test.ts` (остальные гейты расчёта),
 * `tests/integration/orders-client-due-date.test.ts` (сама привязка).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { copySpecLinesTo, createSpecPattern } from '../utils/spec';

describeWithDb('integration — клиент обязателен в заказе', () => {
  let t: TestApp;
  let seed: SeedResult;
  let manager: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    manager = loginAs(t, seed.employees['shop-chief']);
  });

  /**
   * Заказ, готовый к расчёту по всем ОСТАЛЬНЫМ гейтам (pattern +
   * спецификация + qtyPlan > 0). `clientId` передаём опционально — это и
   * есть предмет теста.
   */
  async function createOrderReadyForCalculation(opts?: {
    clientId?: string;
    suffix?: string;
  }): Promise<string> {
    const suffix = opts?.suffix ?? '1';
    const spec = await createSpecPattern(t, manager, {
      name: `Клиент обязателен ${suffix}`,
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
    });
    const pattern = await t.prisma.patternItem.create({
      data: {
        name: `Лекало ${suffix}`,
        article: `P-CLIENT-REQ-${suffix}`,
        status: 'ACTIVE',
      },
    });
    await copySpecLinesTo(t, spec.id, pattern.id);
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-07-26T00:00:00.000Z',
        productId: seed.product.id,
        patternItemId: pattern.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        ...(opts?.clientId ? { clientId: opts.clientId } : {}),
      })
      .expect(201);
    return order.body.id as string;
  }

  // ---------------------------------------------------------------------------
  // 1. POST без clientId остаётся валидным (backward compatibility)
  // ---------------------------------------------------------------------------

  test('POST /api/orders без clientId → 201 DRAFT (ручка backward-compatible)', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-07-26T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 3 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.clientId).toBeNull();
    expect(res.body.status).toBe('DRAFT');
  });

  // ---------------------------------------------------------------------------
  // 2. Гейт расчёта: без клиента заказ не уезжает из DRAFT
  // ---------------------------------------------------------------------------

  test('start-calculation без клиента → 400 ORDER_CLIENT_REQUIRED, заказ остаётся DRAFT', async () => {
    const orderId = await createOrderReadyForCalculation();

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORDER_CLIENT_REQUIRED');

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('DRAFT');
    // Гейт стоит ДО `calculateForOrder` — потребностей цеха не появилось.
    const needs = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    expect(needs.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Дозаполнили клиента → расчёт проходит
  // ---------------------------------------------------------------------------

  test('после PATCH clientId тот же заказ уходит в расчёт', async () => {
    const orderId = await createOrderReadyForCalculation({ suffix: '2' });

    const patched = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({ clientId: seed.client.id });
    expect(patched.status).toBe(200);
    expect(patched.body.clientId).toBe(seed.client.id);

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('CALCULATION');
  });

  // ---------------------------------------------------------------------------
  // 4. Клиента нельзя снять
  // ---------------------------------------------------------------------------

  test('PATCH clientId=null → 400 ORDER_CLIENT_REQUIRED (снять клиента нельзя)', async () => {
    const orderId = await createOrderReadyForCalculation({
      clientId: seed.client.id,
      suffix: '3',
    });

    const res = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({ clientId: null });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORDER_CLIENT_REQUIRED');

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.clientId).toBe(seed.client.id);
  });

  test('PATCH clientId=null отбивается и на заказе в производстве', async () => {
    const orderId = await createOrderReadyForCalculation({
      clientId: seed.client.id,
      suffix: '4',
    });
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', manager)
      .send({})
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({ clientId: null });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORDER_CLIENT_REQUIRED');

    // Замена клиента на непустого — по-прежнему разрешена на любом статусе
    // («безопасное» поле, см. `OrdersService.update`).
    const another = await t.prisma.client.create({
      data: { name: 'ИП Второй', isActive: true },
    });
    const swap = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({ clientId: another.id });
    expect(swap.status).toBe(200);
    expect(swap.body.clientId).toBe(another.id);
  });

  // ---------------------------------------------------------------------------
  // 5. Очерёдность гейтов расчёта не изменилась
  // ---------------------------------------------------------------------------

  test('без лекала И без клиента первым отдаётся ORDER_PATTERN_REQUIRED', async () => {
    // Заказ без лекала: гейт лекала должен сработать раньше клиента.
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-07-26T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/start-calculation`)
      .set('Cookie', manager)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORDER_PATTERN_REQUIRED');
  });
});
