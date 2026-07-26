/**
 * Integration-тесты этапа «Себестоимость заказа»
 * (`OrdersController.completeCalculation` / `reopenCalculation`,
 * `OrderCostEstimatesService`, `prisma/schema.prisma::OrderCostEstimate`).
 *
 * Покрытие:
 *   1. Happy-path: заполнили purchaseQty/quotedPrice/RUB → 201,
 *      Order.status = CALCULATION_DONE, OrderCostEstimate(+lines) создан;
 *   2. USD без usdRateRub → 422 ORDER_CALCULATION_USD_RATE_REQUIRED;
 *   3. USD с usdRateRub → 201, lineTotalRub = qty × price × rate;
 *   4. Reopen-calculation → status = CALCULATION + estimate REVOKED,
 *      WorkshopNeed остаются нетронутыми;
 *   5. Incomplete (нет цены) → 422 ORDER_CALCULATION_INCOMPLETE;
 *   6. complete-calculation из не-CALCULATION → 409
 *      ORDER_CALCULATION_INVALID_STATUS.
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

describeWithDb('integration — order cost estimates', () => {
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

  // -------------------------------------------------------------------------
  // 1. Happy-path: RUB-only расчёт
  // -------------------------------------------------------------------------

  test('CALCULATION + RUB-строки → CALCULATION_DONE, создан OrderCostEstimate', async () => {
    const orderId = await prepareCalculationOrder(t, seed, cookie);

    // Заполняем все строки: purchaseQty + цена + RUB.
    const needs = await t.prisma.workshopNeed.findMany({
      where: { orderId },
    });
    expect(needs.length).toBeGreaterThan(0);
    for (const n of needs) {
      await request(t.app.getHttpServer())
        .patch(`/api/workshop-needs/${n.id}`)
        .set('Cookie', cookie)
        .send({
          purchaseQty: '10',
          quotedPrice: '125.50',
          quotedCurrency: 'RUB',
        })
        .expect(200);
    }

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookie)
      .send({});
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('COMPLETED');
    expect(r.body.version).toBe(1);
    expect(Number(r.body.totalCostRub)).toBeCloseTo(
      10 * 125.5 * needs.length,
      2,
    );
    expect(r.body.lines.length).toBe(needs.length);
    expect(r.body.usdRateRub).toBeNull();

    // Order переключился в CALCULATION_DONE + snapshot-поля.
    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('CALCULATION_DONE');
    expect(Number(order?.costEstimateTotalRub)).toBeCloseTo(
      10 * 125.5 * needs.length,
      2,
    );
    expect(order?.costEstimateVersion).toBe(1);
    expect(order?.costEstimateCompletedAt).not.toBeNull();

    // OrderCostEstimate + lines в БД.
    const estimate = await t.prisma.orderCostEstimate.findFirst({
      where: { orderId },
      include: { lines: true },
    });
    expect(estimate).not.toBeNull();
    expect(estimate?.status).toBe('COMPLETED');
    expect(estimate?.lines.length).toBe(needs.length);

    // PurchaseOrder/Receipt не созданы (мы их и не трогали).
    const poCount = await t.prisma.purchaseOrder.count({
      where: { customerOrderId: orderId },
    });
    expect(poCount).toBe(0);
    const prCount = await t.prisma.purchaseReceipt.count({
      where: { customerOrderId: orderId },
    });
    expect(prCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. USD без usdRateRub → 422
  // -------------------------------------------------------------------------

  test('USD-строка без usdRateRub → 422 ORDER_CALCULATION_USD_RATE_REQUIRED', async () => {
    const orderId = await prepareCalculationOrder(t, seed, cookie);
    const needs = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    for (const n of needs) {
      await request(t.app.getHttpServer())
        .patch(`/api/workshop-needs/${n.id}`)
        .set('Cookie', cookie)
        .send({
          purchaseQty: '5',
          quotedPrice: '10',
          quotedCurrency: 'USD',
        })
        .expect(200);
    }
    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookie)
      .send({});
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('ORDER_CALCULATION_USD_RATE_REQUIRED');

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('CALCULATION');
  });

  // -------------------------------------------------------------------------
  // 3. USD c usdRateRub → конвертация по курсу
  // -------------------------------------------------------------------------

  test('USD + usdRateRub → lineTotalRub конвертирован', async () => {
    const orderId = await prepareCalculationOrder(t, seed, cookie);
    const needs = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    for (const n of needs) {
      await request(t.app.getHttpServer())
        .patch(`/api/workshop-needs/${n.id}`)
        .set('Cookie', cookie)
        .send({
          purchaseQty: '4',
          quotedPrice: '20',
          quotedCurrency: 'USD',
        })
        .expect(200);
    }
    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookie)
      .send({ usdRateRub: '95' });
    expect(r.status).toBe(201);
    expect(Number(r.body.usdRateRub)).toBeCloseTo(95, 4);
    // 4 × 20 = 80 USD per line; × 95 = 7600 RUB; total = 7600 × needs.
    expect(Number(r.body.totalCostRub)).toBeCloseTo(7600 * needs.length, 2);
    for (const l of r.body.lines) {
      expect(Number(l.lineTotalOriginal)).toBeCloseTo(80, 2);
      expect(Number(l.lineTotalRub)).toBeCloseTo(7600, 2);
      expect(l.quotedCurrency).toBe('USD');
    }
  });

  // -------------------------------------------------------------------------
  // 4. Reopen-calculation: estimate REVOKED, WorkshopNeed нетронуты
  // -------------------------------------------------------------------------

  test('reopen-calculation → status = CALCULATION, estimate REVOKED, WorkshopNeed целы', async () => {
    const orderId = await prepareCalculationOrder(t, seed, cookie);
    const needsBefore = await t.prisma.workshopNeed.findMany({
      where: { orderId },
    });
    for (const n of needsBefore) {
      await request(t.app.getHttpServer())
        .patch(`/api/workshop-needs/${n.id}`)
        .set('Cookie', cookie)
        .send({
          purchaseQty: '7',
          quotedPrice: '50',
          quotedCurrency: 'RUB',
        })
        .expect(200);
    }
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);

    // Reopen.
    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/reopen-calculation`)
      .set('Cookie', cookie)
      .send({ reason: 'нашли ошибку в цене' });
    expect(r.status).toBe(201);
    expect(r.body?.status).toBe('REVOKED');

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('CALCULATION');
    expect(order?.costEstimateTotalRub).toBeNull();
    expect(order?.costEstimateCompletedAt).toBeNull();
    expect(order?.costEstimateVersion).toBeNull();

    // Estimate помечен REVOKED, не удалён.
    const estimate = await t.prisma.orderCostEstimate.findFirst({
      where: { orderId },
    });
    expect(estimate?.status).toBe('REVOKED');
    expect(estimate?.revokedAt).not.toBeNull();
    expect(estimate?.comment).toBe('нашли ошибку в цене');

    // WorkshopNeed остались живыми, цены / qty не очищены.
    const needsAfter = await t.prisma.workshopNeed.findMany({
      where: { orderId },
    });
    expect(needsAfter.length).toBe(needsBefore.length);
    for (const n of needsAfter) {
      expect(Number(n.purchaseQty)).toBe(7);
      expect(Number(n.quotedPrice)).toBe(50);
      expect(n.quotedCurrency).toBe('RUB');
    }
  });

  // -------------------------------------------------------------------------
  // 5. Incomplete: одна строка без цены → 422 + список проблемных
  // -------------------------------------------------------------------------

  test('строка без цены → 422 ORDER_CALCULATION_INCOMPLETE, статус остаётся CALCULATION', async () => {
    const orderId = await prepareCalculationOrder(t, seed, cookie);
    const needs = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    // Заполняем все, кроме первой.
    for (const [i, n] of needs.entries()) {
      if (i === 0) continue;
      await request(t.app.getHttpServer())
        .patch(`/api/workshop-needs/${n.id}`)
        .set('Cookie', cookie)
        .send({ purchaseQty: '3', quotedPrice: '15', quotedCurrency: 'RUB' })
        .expect(200);
    }
    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookie)
      .send({});
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('ORDER_CALCULATION_INCOMPLETE');

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('CALCULATION');
  });

  // -------------------------------------------------------------------------
  // 6. Invalid status: complete-calculation из DRAFT
  // -------------------------------------------------------------------------

  test('complete-calculation из DRAFT → 409 ORDER_CALCULATION_INVALID_STATUS', async () => {
    const orderId = await prepareDraftReady(t, seed, cookie);
    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookie)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ORDER_CALCULATION_INVALID_STATUS');
  });
});

// ===========================================================================
// helpers
// ===========================================================================

async function prepareDraftReady(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
): Promise<string> {
  const tc = await request(t.app.getHttpServer())
    .post('/api/tech-cards')
    .set('Cookie', cookie)
    .send({
      code: `TC-CE-${Date.now()}`,
      name: 'Cost estimate flow',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1' }],
    })
    .expect(201);
  const pattern = await t.prisma.patternItem.create({
    data: {
      name: 'Лекало стоимости',
      article: `P-CE-${Date.now()}`,
      status: 'ACTIVE',
    },
  });
  const order = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      clientId: seed.client.id,
      productId: seed.product.id,
      items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
      techCardId: tc.body.id,
      patternItemId: pattern.id,
    })
    .expect(201);
  return order.body.id as string;
}

async function prepareCalculationOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
): Promise<string> {
  const orderId = await prepareDraftReady(t, seed, cookie);
  await request(t.app.getHttpServer())
    .post(`/api/orders/${orderId}/start-calculation`)
    .set('Cookie', cookie)
    .send({})
    .expect(201);
  return orderId;
}
