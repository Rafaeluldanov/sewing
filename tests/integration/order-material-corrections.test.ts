/**
 * Integration-тесты этапа «Корректировка материалов после просчёта»
 * (ручные строки `WorkshopNeed.isManual`, `OrderExtraCost`,
 * `OrderCostEstimatesService.recalculateCostEstimate`).
 *
 * Покрытие:
 *   1. Ручная строка: create → isManual/MANUAL_ADDITION, видна в списке;
 *      edit состава → обновилось; delete → исчезла.
 *   2. Системную строку нельзя править/удалять → 409 WORKSHOP_NEED_NOT_MANUAL.
 *   3. Прочие расходы: create/list/update/delete.
 *   4. Корректировка в DRAFT → 409 ORDER_MATERIAL_CORRECTION_INVALID_STATUS.
 *   5. Ручной материал + прочий расход попадают в completeCalculation
 *      (строка kind=OTHER, sourceType=EXTRA_COST), входят в total.
 *   6. recalculate-cost-estimate из CALCULATION_DONE: новая версия,
 *      статус заказа не меняется, прошлый расчёт REVOKED, total учитывает
 *      добавленный после фиксации расход.
 *   7. recalculate из CALCULATION → 409 ORDER_CALCULATION_INVALID_STATUS.
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

describeWithDb('integration — order material corrections', () => {
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
  // 1. Ручная строка: create / edit / delete
  // -------------------------------------------------------------------------

  test('ручная строка: create → edit → delete', async () => {
    const orderId = await prepareCalculationOrder(t, seed, cookie);

    const created = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/manual`)
      .set('Cookie', cookie)
      .send({
        description: 'Молния потайная (непредвиденно)',
        unit: 'шт',
        calculatedQty: '12',
        materialRole: 'PACKAGING',
      });
    expect(created.status).toBe(201);
    expect(created.body.isManual).toBe(true);
    expect(created.body.sourceType).toBe('MANUAL_ADDITION');
    expect(created.body.status).toBe('REVIEWED');
    expect(created.body.description).toBe('Молния потайная (непредвиденно)');
    const needId = created.body.id as string;

    // Видна в списке потребностей заказа.
    const list = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/workshop-needs`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.some((n: { id: string }) => n.id === needId)).toBe(true);

    // Правка состава ручной строки.
    const edited = await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookie)
      .send({ description: 'Молния (уточнено)', calculatedQty: '15', unit: 'шт' });
    expect(edited.status).toBe(200);
    expect(edited.body.description).toBe('Молния (уточнено)');
    expect(Number(edited.body.calculatedQty)).toBe(15);

    // Удаление ручной строки.
    await request(t.app.getHttpServer())
      .delete(`/api/orders/${orderId}/workshop-needs/${needId}`)
      .set('Cookie', cookie)
      .expect(204);
    const gone = await t.prisma.workshopNeed.findUnique({ where: { id: needId } });
    expect(gone).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. Системную строку нельзя править / удалять
  // -------------------------------------------------------------------------

  test('системную строку нельзя править/удалять → 409 WORKSHOP_NEED_NOT_MANUAL', async () => {
    const orderId = await prepareCalculationOrder(t, seed, cookie);
    const sys = await t.prisma.workshopNeed.findFirst({
      where: { orderId, isManual: false },
    });
    expect(sys).not.toBeNull();

    // PATCH состава системной строки.
    const patch = await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${sys!.id}`)
      .set('Cookie', cookie)
      .send({ description: 'пытаемся переименовать' });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe('WORKSHOP_NEED_NOT_MANUAL');

    // Но purchaseQty/цену у системной строки править по-прежнему можно.
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${sys!.id}`)
      .set('Cookie', cookie)
      .send({ purchaseQty: '5', quotedPrice: '10', quotedCurrency: 'RUB' })
      .expect(200);

    // DELETE системной строки запрещён.
    const del = await request(t.app.getHttpServer())
      .delete(`/api/orders/${orderId}/workshop-needs/${sys!.id}`)
      .set('Cookie', cookie);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('WORKSHOP_NEED_NOT_MANUAL');
  });

  // -------------------------------------------------------------------------
  // 3. Прочие расходы: CRUD
  // -------------------------------------------------------------------------

  test('прочие расходы: create / list / update / delete', async () => {
    const orderId = await prepareCalculationOrder(t, seed, cookie);

    const created = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/extra-costs`)
      .set('Cookie', cookie)
      .send({ description: 'Доставка из Турции', amount: '15000', currency: 'RUB' });
    expect(created.status).toBe(201);
    expect(created.body.includeInCostPrice).toBe(true);
    expect(created.body.createdAtStatus).toBe('CALCULATION');
    const costId = created.body.id as string;

    const list = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/extra-costs`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.length).toBe(1);

    const updated = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/extra-costs/${costId}`)
      .set('Cookie', cookie)
      .send({ amount: '18000', includeInCostPrice: false });
    expect(updated.status).toBe(200);
    expect(Number(updated.body.amount)).toBe(18000);
    expect(updated.body.includeInCostPrice).toBe(false);

    await request(t.app.getHttpServer())
      .delete(`/api/orders/${orderId}/extra-costs/${costId}`)
      .set('Cookie', cookie)
      .expect(204);
    const after = await t.prisma.orderExtraCost.count({ where: { orderId } });
    expect(after).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. Корректировка в DRAFT запрещена
  // -------------------------------------------------------------------------

  test('корректировка в DRAFT → 409 ORDER_MATERIAL_CORRECTION_INVALID_STATUS', async () => {
    const orderId = await prepareDraftReady(t, seed, cookie);

    const need = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/manual`)
      .set('Cookie', cookie)
      .send({ description: 'Рано', unit: 'шт', calculatedQty: '1' });
    expect(need.status).toBe(409);
    expect(need.body.code).toBe('ORDER_MATERIAL_CORRECTION_INVALID_STATUS');

    const cost = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/extra-costs`)
      .set('Cookie', cookie)
      .send({ description: 'Рано', amount: '100', currency: 'RUB' });
    expect(cost.status).toBe(409);
    expect(cost.body.code).toBe('ORDER_MATERIAL_CORRECTION_INVALID_STATUS');
  });

  // -------------------------------------------------------------------------
  // 5. Ручной материал + прочий расход попадают в completeCalculation
  // -------------------------------------------------------------------------

  test('ручной материал и прочий расход входят в смету', async () => {
    const orderId = await prepareCalculationOrder(t, seed, cookie);

    // Системные строки: цена/кол-во.
    const sysNeeds = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    for (const n of sysNeeds) {
      await request(t.app.getHttpServer())
        .patch(`/api/workshop-needs/${n.id}`)
        .set('Cookie', cookie)
        .send({ purchaseQty: '2', quotedPrice: '100', quotedCurrency: 'RUB' })
        .expect(200);
    }

    // Ручной материал с ценой: 3 × 200 = 600.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/manual`)
      .set('Cookie', cookie)
      .send({
        description: 'Доп. фурнитура',
        unit: 'шт',
        calculatedQty: '3',
        purchaseQty: '3',
        quotedPrice: '200',
        quotedCurrency: 'RUB',
      })
      .expect(201);

    // Прочий расход 5000 ₽, в себестоимость.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/extra-costs`)
      .set('Cookie', cookie)
      .send({ description: 'Логистика', amount: '5000', currency: 'RUB' })
      .expect(201);

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookie)
      .send({});
    expect(r.status).toBe(201);

    // total = системные (2×100×N) + ручной 600 + расход 5000.
    const sysTotal = 2 * 100 * sysNeeds.length;
    expect(Number(r.body.totalCostRub)).toBeCloseTo(sysTotal + 600 + 5000, 2);

    // Строка прочего расхода в смете: kind=OTHER, sourceType=EXTRA_COST.
    const extraLine = r.body.lines.find(
      (l: { sourceType: string }) => l.sourceType === 'EXTRA_COST',
    );
    expect(extraLine).toBeDefined();
    expect(extraLine.kind).toBe('OTHER');
    expect(Number(extraLine.lineTotalRub)).toBeCloseTo(5000, 2);
  });

  // -------------------------------------------------------------------------
  // 6. recalculate из CALCULATION_DONE: новая версия, статус не меняется
  // -------------------------------------------------------------------------

  test('recalculate из CALCULATION_DONE → новая версия, статус прежний, расход учтён', async () => {
    const orderId = await prepareCalculationOrder(t, seed, cookie);
    const sysNeeds = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    for (const n of sysNeeds) {
      await request(t.app.getHttpServer())
        .patch(`/api/workshop-needs/${n.id}`)
        .set('Cookie', cookie)
        .send({ purchaseQty: '1', quotedPrice: '100', quotedCurrency: 'RUB' })
        .expect(200);
    }
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);

    const baseTotal = 100 * sysNeeds.length;

    // Уже после фиксации добавляем непредвиденный расход.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/extra-costs`)
      .set('Cookie', cookie)
      .send({ description: 'Штраф за срыв срока', amount: '3000', currency: 'RUB' })
      .expect(201);

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/recalculate-cost-estimate`)
      .set('Cookie', cookie)
      .send({});
    expect(r.status).toBe(201);
    expect(r.body.version).toBe(2);
    expect(Number(r.body.totalCostRub)).toBeCloseTo(baseTotal + 3000, 2);

    // Статус заказа НЕ изменился.
    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('CALCULATION_DONE');
    expect(order?.costEstimateVersion).toBe(2);

    // Прошлая версия помечена REVOKED, активна только новая.
    const completed = await t.prisma.orderCostEstimate.findMany({
      where: { orderId, status: 'COMPLETED' },
    });
    expect(completed.length).toBe(1);
    expect(completed[0].version).toBe(2);
    const revoked = await t.prisma.orderCostEstimate.findMany({
      where: { orderId, status: 'REVOKED' },
    });
    expect(revoked.length).toBe(1);
    expect(revoked[0].version).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 7. recalculate из CALCULATION → 409
  // -------------------------------------------------------------------------

  test('recalculate из CALCULATION → 409 ORDER_CALCULATION_INVALID_STATUS', async () => {
    const orderId = await prepareCalculationOrder(t, seed, cookie);
    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/recalculate-cost-estimate`)
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
      code: `TC-MC-${Date.now()}`,
      name: 'Material corrections flow',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1' }],
    })
    .expect(201);
  const pattern = await t.prisma.patternItem.create({
    data: {
      name: 'Лекало коррекций',
      article: `P-MC-${Date.now()}`,
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
