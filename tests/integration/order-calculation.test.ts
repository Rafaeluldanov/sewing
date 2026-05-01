/**
 * Integration-тесты этапа «Расчёт» (`OrdersService.startCalculation`).
 *
 * Покрытие (минимально достаточный contract-floor):
 *   1. DRAFT с pattern+techCard+items → CALCULATION + WorkshopNeed создаются;
 *   2. DRAFT без patternItemId → 400 ORDER_PATTERN_REQUIRED;
 *   3. DRAFT без techCardId → 400 ORDER_TECH_CARD_REQUIRED;
 *   4. DRAFT без qtyPlan → 400 ORDER_ITEMS_REQUIRED;
 *   5. WorkshopNeed REVIEWED → 409 WORKSHOP_NEEDS_ALREADY_REVIEWED,
 *      статус остаётся DRAFT;
 *   6. IN_PRODUCTION → 409 ORDER_INVALID_STATUS_TRANSITION;
 *   7. CALCULATION → IN_PRODUCTION через `start()` работает;
 *   8. RBAC: рабочая роль (QC) → 403.
 *
 * Не проверяем здесь:
 *   - сам расчёт WorkshopNeed (это в `workshop-needs.test.ts`);
 *   - UI (это smoke `order-calculation.smoke.test.ts`).
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

describeWithDb('integration — order calculation (этап «Расчёт»)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      qc: loginAs(t, seed.employees['qc']),
    };
  });

  // ---------------------------------------------------------------------------
  // 1. Happy-path: DRAFT → CALCULATION + WorkshopNeed создаётся
  // ---------------------------------------------------------------------------

  test('DRAFT с pattern + techCard + items → CALCULATION с WorkshopNeed', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-SC-1',
      name: 'Start calculation demo',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
    });
    const pattern = await t.prisma.patternItem.create({
      data: {
        name: 'Лекало демо',
        article: 'P-SC-1',
        status: 'ACTIVE',
      },
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      techCardId: tc.id,
      patternItemId: pattern.id,
    });

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('CALCULATION');

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('CALCULATION');

    const needs = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    expect(needs.length).toBe(1);
    expect(needs[0].status).toBe('CALCULATED');
    // QTY_PER_UNIT: 1.5 × 10 = 15
    expect(Number(needs[0].calculatedQty)).toBeCloseTo(15, 4);

    // Audit ORDER_CALCULATION_STARTED ушёл в журнал.
    const audit = await t.prisma.auditLog.findFirst({
      where: { event: 'ORDER_CALCULATION_STARTED', entityId: orderId },
    });
    expect(audit).not.toBeNull();
    expect((audit?.payload as Record<string, unknown>)?.workshopNeedsCount).toBe(
      1,
    );
  });

  // ---------------------------------------------------------------------------
  // 2. ORDER_PATTERN_REQUIRED: без patternItemId
  // ---------------------------------------------------------------------------

  test('DRAFT без patternItemId → 400 ORDER_PATTERN_REQUIRED', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-NOPAT',
      name: 'Без лекала',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      techCardId: tc.id,
      patternItemId: null,
    });

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ORDER_PATTERN_REQUIRED');
    // Статус не сменился.
    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('DRAFT');
  });

  // ---------------------------------------------------------------------------
  // 3. ORDER_TECH_CARD_REQUIRED: без techCardId
  // ---------------------------------------------------------------------------

  test('DRAFT без techCardId → 400 ORDER_TECH_CARD_REQUIRED', async () => {
    const pattern = await t.prisma.patternItem.create({
      data: {
        name: 'Лекало демо',
        article: 'P-NOT-1',
        status: 'ACTIVE',
      },
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      techCardId: null,
      patternItemId: pattern.id,
    });

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ORDER_TECH_CARD_REQUIRED');
    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('DRAFT');
  });

  // ---------------------------------------------------------------------------
  // 4. ORDER_ITEMS_REQUIRED: все qtyPlan = 0
  // ---------------------------------------------------------------------------

  test('DRAFT без qtyPlan > 0 → 400 ORDER_ITEMS_REQUIRED', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-EMPTY',
      name: 'Empty qty',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
    });
    const pattern = await t.prisma.patternItem.create({
      data: {
        name: 'Лекало демо',
        article: 'P-EM-1',
        status: 'ACTIVE',
      },
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      techCardId: tc.id,
      patternItemId: pattern.id,
    });
    // Эмулируем дегенеративный снимок «qtyPlan = 0» (Zod на create
    // отбивает это, поэтому правим уже после create).
    await t.prisma.orderItem.updateMany({
      where: { orderId },
      data: { qtyPlan: 0 },
    });

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ORDER_ITEMS_REQUIRED');
    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('DRAFT');
  });

  // ---------------------------------------------------------------------------
  // 5. WORKSHOP_NEEDS_ALREADY_REVIEWED: ручные правки закупщика защищены
  // ---------------------------------------------------------------------------

  test('REVIEWED-строка блокирует start-calculation (статус остаётся DRAFT)', async () => {
    const orderId = await prepareReadyOrder(t, seed, cookies.manager);

    // Считаем потребности руками через manual-эндпоинт.
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const needId = calc.body.needs[0].id;
    // Закупщик переводит в REVIEWED.
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookies.manager)
      .send({ status: 'REVIEWED' })
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('WORKSHOP_NEEDS_ALREADY_REVIEWED');
    // Статус заказа не изменился — остался DRAFT.
    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('DRAFT');
  });

  // ---------------------------------------------------------------------------
  // 6. ORDER_INVALID_STATUS_TRANSITION: нельзя из IN_PRODUCTION
  // ---------------------------------------------------------------------------

  test('IN_PRODUCTION → 409 ORDER_INVALID_STATUS_TRANSITION', async () => {
    const orderId = await prepareReadyOrder(t, seed, cookies.manager);

    // Запускаем заказ напрямую (без расчёта — старый flow).
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ORDER_INVALID_STATUS_TRANSITION');
  });

  // ---------------------------------------------------------------------------
  // 7. CALCULATION → IN_PRODUCTION через start() работает
  // ---------------------------------------------------------------------------

  test('CALCULATION → IN_PRODUCTION: start() допускает оба исходных статуса', async () => {
    const orderId = await prepareReadyOrder(t, seed, cookies.manager);

    // DRAFT → CALCULATION
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    // CALCULATION → IN_PRODUCTION
    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('IN_PRODUCTION');

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('IN_PRODUCTION');

    // Audit: в ORDER_STARTED.payload.fromStatus теперь CALCULATION.
    const audit = await t.prisma.auditLog.findFirst({
      where: { event: 'ORDER_STARTED', entityId: orderId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect((audit?.payload as Record<string, unknown>)?.fromStatus).toBe(
      'CALCULATION',
    );
  });

  // ---------------------------------------------------------------------------
  // 8. RBAC
  // ---------------------------------------------------------------------------

  test('Рабочая роль (QC) → 403 на start-calculation', async () => {
    const orderId = await prepareReadyOrder(t, seed, cookies.manager);
    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(r.status).toBe(403);
  });
});

// ===========================================================================
// helpers
// ===========================================================================

async function createTechCard(
  t: TestApp,
  cookie: string,
  body: {
    code: string;
    name: string;
    materialLines?: Array<{
      name: string;
      unit: string;
      qtyPerUnit: string;
      materialRole?: string | null;
      densityGsm?: number | null;
    }>;
  },
): Promise<{ id: string }> {
  const r = await request(t.app.getHttpServer())
    .post('/api/tech-cards')
    .set('Cookie', cookie)
    .send(body)
    .expect(201);
  return { id: r.body.id };
}

async function createOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  options: {
    items: Array<{ sizeId: string; qtyPlan: number }>;
    techCardId: string | null;
    patternItemId: string | null;
  },
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items: options.items,
      techCardId: options.techCardId ?? undefined,
      patternItemId: options.patternItemId ?? undefined,
    })
    .expect(201);
  return r.body.id as string;
}

/**
 * Готовый к расчёту заказ: DRAFT, есть techCard + pattern + qtyPlan > 0.
 */
async function prepareReadyOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
): Promise<string> {
  const tc = await createTechCard(t, cookie, {
    code: 'TC-READY',
    name: 'Ready order tech card',
    materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
  });
  const pattern = await t.prisma.patternItem.create({
    data: {
      name: 'Лекало готовое',
      article: 'P-READY-1',
      status: 'ACTIVE',
    },
  });
  return createOrder(t, seed, cookie, {
    items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
    techCardId: tc.id,
    patternItemId: pattern.id,
  });
}
