/**
 * Integration-тесты этапа 2 «План операций на заказе»
 * (см. `docs/operation-time-norms-recon.md §10/§11`,
 * `apps/api/src/modules/orders/order-operation-plan.service.ts`).
 *
 * Сценарии (минимально-достаточный contract-floor):
 *   1. FIXED price 100 + FIXED time 100 sec, qty=10 →
 *      operationCostPlanRub=1000, operationTimePlanSec=1000.
 *   2. BY_SIZE price/time:
 *        M: 50₽ / 100с;
 *        L: 80₽ / 150с;
 *      qty(M)=10, qty(L)=5 → cost=900, time=1750.
 *   3. SALARY_ONLY с FIXED-нормой времени → cost=0, time>0.
 *   4. Нет нормы времени → warning, time для этой пары игнорируется.
 *   5. Нет ставки (BY_SIZE без матчинга по размеру) → warning,
 *      cost для этой пары игнорируется.
 *   6. Update DRAFT items → план пересчитывается.
 *   7. Заказ без routeTemplateId → план = null + warning «Маршрут
 *      не выбран».
 *   8. completeCalculation НЕ добавляет LABOR-строку (этап 3) —
 *      `OrderCostEstimate.totalCostRub` не зависит от плана операций.
 *
 * Что НЕ проверяем здесь:
 *   - UI (smoke `order-operation-plan.smoke.test.ts`);
 *   - сам расчёт WorkshopNeed / OrderCostEstimate
 *     (это `workshop-needs.test.ts` / `order-cost-estimates.test.ts`);
 *   - payroll/Passport (этап 2 их не трогает; историческая
 *     таблица PieceRate удалена в PHASE 2 STEP 1, ставки живут
 *     в Operation.fixedRate / OperationRateBySize).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — order operation plan (Этап 2)', () => {
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
    };
  });

  // ---------------------------------------------------------------------------
  // 1. FIXED price + FIXED time
  // ---------------------------------------------------------------------------

  test('FIXED-price 100 + FIXED-time 100s × qty 10 → cost=1000, time=1000', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-FIX',
      name: 'План FIXED',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 100,
    });
    const route = await createRoute(t, { code: 'RT-FIX', operationIds: [op.id] });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order).not.toBeNull();
    expect(Number(order!.operationCostPlanRub)).toBeCloseTo(1000, 2);
    expect(order!.operationTimePlanSec).toBe(1000);
    expect(order!.operationPlanCalculatedAt).not.toBeNull();
    expect(order!.operationPlanWarnings).toBeNull();

    // DTO `/api/orders/:id` отдаёт snapshot полей. Decimal приходит
    // строкой через `Prisma.Decimal.toString()` (без trailing-нулей —
    // `1000` вместо `1000.00`); это backward-compat с тем, как
    // сериализуется `costEstimateTotalRub`.
    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(Number(detail.body.operationCostPlanRub)).toBeCloseTo(1000, 2);
    expect(detail.body.operationTimePlanSec).toBe(1000);
    expect(detail.body.operationPlanWarnings).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 2. BY_SIZE price + BY_SIZE time
  // ---------------------------------------------------------------------------

  test('BY_SIZE price/time, qty(M)=10 qty(L)=5 → cost=900, time=1750', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-BYSZ',
      name: 'План BY_SIZE',
      pricingMode: 'BY_SIZE',
      ratesBySize: [
        { sizeId: seed.sizes.M, rate: 50 },
        { sizeId: seed.sizes.L, rate: 80 },
      ],
      timeNormMode: 'BY_SIZE',
      timeNormsBySize: [
        { sizeId: seed.sizes.M, seconds: 100 },
        { sizeId: seed.sizes.L, seconds: 150 },
      ],
    });
    const route = await createRoute(t, { code: 'RT-BYSZ', operationIds: [op.id] });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [
        { sizeId: seed.sizes.M, qtyPlan: 10 },
        { sizeId: seed.sizes.L, qtyPlan: 5 },
      ],
      routeTemplateId: route.id,
    });

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(Number(order!.operationCostPlanRub)).toBeCloseTo(900, 2); // 10*50 + 5*80
    expect(order!.operationTimePlanSec).toBe(1750); // 10*100 + 5*150
    expect(order!.operationPlanWarnings).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 3. SALARY_ONLY + FIXED time
  // ---------------------------------------------------------------------------

  test('SALARY_ONLY без плановой ставки + FIXED-time 60s, qty 10 → cost=0, time=600, warning', async () => {
    // SALARY_ONLY без `Operation.salaryPlanRubPerShift` ⇒ деньги по
    // операции = 0 + warning «Не задана плановая окладная ставка»
    // (см. ТЗ «Плановая стоимость окладных операций»). Время
    // считается без изменений.
    const op = await createOperation(t, {
      code: 'PLAN-SAL',
      name: 'План SALARY',
      pricingMode: 'SALARY_ONLY',
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });
    const route = await createRoute(t, { code: 'RT-SAL', operationIds: [op.id] });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(Number(order!.operationCostPlanRub)).toBe(0);
    expect(order!.operationTimePlanSec).toBe(600);
    const warnings = order!.operationPlanWarnings as string[];
    expect(warnings).not.toBeNull();
    expect(
      warnings.some((w) =>
        w.includes('Не задана плановая окладная ставка'),
      ),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 4. Missing time norm — warning + время по операции = 0
  // ---------------------------------------------------------------------------

  test('FIXED-price 100 без нормы времени → cost=1000, time=0, warning о норме', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-NOT',
      name: 'План без нормы',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: null, // нормы нет
    });
    const route = await createRoute(t, { code: 'RT-NOT', operationIds: [op.id] });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(Number(order!.operationCostPlanRub)).toBeCloseTo(1000, 2);
    expect(order!.operationTimePlanSec).toBe(0);
    expect(order!.operationPlanWarnings).not.toBeNull();
    const warnings = order!.operationPlanWarnings as string[];
    expect(warnings.some((w) => w.includes('Нет нормы времени'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 5. Missing rate — warning + cost для пары = 0
  // ---------------------------------------------------------------------------

  test('BY_SIZE без ставки на размер L → cost учитывает только M, warning о ставке', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-RBSZ',
      name: 'План BY_SIZE без L',
      pricingMode: 'BY_SIZE',
      ratesBySize: [{ sizeId: seed.sizes.M, rate: 50 }], // нет L
      timeNormMode: 'BY_SIZE',
      timeNormsBySize: [
        { sizeId: seed.sizes.M, seconds: 100 },
        { sizeId: seed.sizes.L, seconds: 150 },
      ],
    });
    const route = await createRoute(t, { code: 'RT-RBSZ', operationIds: [op.id] });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [
        { sizeId: seed.sizes.M, qtyPlan: 10 },
        { sizeId: seed.sizes.L, qtyPlan: 5 },
      ],
      routeTemplateId: route.id,
    });

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    // cost = 10×50 (M) + 0 (L нет ставки) = 500
    expect(Number(order!.operationCostPlanRub)).toBeCloseTo(500, 2);
    // time = 10×100 + 5×150 = 1750 (норма времени по обоим есть)
    expect(order!.operationTimePlanSec).toBe(1750);
    const warnings = order!.operationPlanWarnings as string[];
    expect(warnings.some((w) => w.includes('Нет ставки операции'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 6. Update DRAFT items → план пересчитывается
  // ---------------------------------------------------------------------------

  test('Update DRAFT items → план пересчитывается', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-UPD',
      name: 'План UPDATE',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });
    const route = await createRoute(t, { code: 'RT-UPD', operationIds: [op.id] });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      routeTemplateId: route.id,
    });

    const before = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(Number(before!.operationCostPlanRub)).toBeCloseTo(500, 2); // 5*100
    expect(before!.operationTimePlanSec).toBe(300); // 5*60

    // Меняем qtyPlan через PATCH /api/orders/:id (DRAFT).
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .send({
        items: [{ sizeId: seed.sizes.M, qtyPlan: 12 }],
      })
      .expect(200);

    const after = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(Number(after!.operationCostPlanRub)).toBeCloseTo(1200, 2); // 12*100
    expect(after!.operationTimePlanSec).toBe(720); // 12*60
  });

  // ---------------------------------------------------------------------------
  // 7. Заказ без маршрута → план = null + warning
  // ---------------------------------------------------------------------------

  test('Заказ без routeTemplateId → план null + warning «Маршрут не выбран»', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: null,
    });

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.operationCostPlanRub).toBeNull();
    expect(order!.operationTimePlanSec).toBeNull();
    expect(order!.operationPlanCalculatedAt).not.toBeNull();
    const warnings = order!.operationPlanWarnings as string[];
    expect(warnings).toEqual([
      'Маршрут не выбран — план операций не рассчитан',
    ]);
  });

  // ---------------------------------------------------------------------------
  // 8. startCalculation → финальный snapshot, completeCalculation
  //    НЕ добавляет LABOR (этап 3 ещё не сделан)
  // ---------------------------------------------------------------------------

  test('startCalculation пересчитывает snapshot; completeCalculation не добавляет LABOR', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-SC',
      name: 'План SC',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });
    const route = await createRoute(t, { code: 'RT-SC', operationIds: [op.id] });
    // Для startCalculation нужны techCard + pattern + items.
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-PLAN-SC',
      name: 'TC PlanSC',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
    });
    const pattern = await t.prisma.patternItem.create({
      data: {
        name: 'Лекало план',
        article: 'P-PLAN-1',
        status: 'ACTIVE',
      },
    });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      routeTemplateId: route.id,
      techCardId: tc.id,
      patternItemId: pattern.id,
    });

    // План уже посчитан на create.
    const draft = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(Number(draft!.operationCostPlanRub)).toBeCloseTo(500, 2);
    expect(draft!.operationTimePlanSec).toBe(300);

    // Меняем «вручную» snapshot, чтобы убедиться, что startCalculation
    // его перезапишет (имитация устаревшего snapshot из предыдущей правки).
    await t.prisma.order.update({
      where: { id: orderId },
      data: {
        operationCostPlanRub: new Prisma.Decimal(99999),
        operationTimePlanSec: 99999,
      },
    });

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    const afterSc = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(afterSc!.status).toBe('CALCULATION');
    // План пересчитан из live данных, наш фейковый snapshot перезаписан.
    expect(Number(afterSc!.operationCostPlanRub)).toBeCloseTo(500, 2);
    expect(afterSc!.operationTimePlanSec).toBe(300);

    // Завершаем расчёт. План на заказе — 500₽, но в OrderCostEstimate
    // никакая LABOR-строка не должна появиться (это будет на этапе 3).
    // Для completeCalculation нужно, чтобы все WorkshopNeed имели
    // purchaseQty/quotedPrice. Заполним.
    const needs = await t.prisma.workshopNeed.findMany({
      where: { orderId },
    });
    for (const need of needs) {
      await t.prisma.workshopNeed.update({
        where: { id: need.id },
        data: {
          purchaseQty: need.calculatedQty ?? new Prisma.Decimal(1),
          quotedPrice: new Prisma.Decimal(10),
          quotedCurrency: 'RUB',
          status: 'PURCHASE_PLANNED',
        },
      });
    }

    // `completeCalculation` отдаёт `OrderCostEstimateDto` (со
    // status='COMPLETED'); сам Order переходит в CALCULATION_DONE
    // отдельным side-effect. Поэтому проверяем статус заказа в БД,
    // а не в response body.
    const completeResp = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    expect(completeResp.body.status).toBe('COMPLETED'); // OrderCostEstimate.status

    // Себестоимость не должна включать план операций (этап 3 не реализован).
    const estimate = await t.prisma.orderCostEstimate.findFirst({
      where: { orderId, status: 'COMPLETED' },
      include: { lines: true },
    });
    expect(estimate).not.toBeNull();
    // Среди строк ни одной с kind='LABOR' (этап 3 ещё не реализован).
    expect(estimate!.lines.every((l) => l.kind !== 'LABOR')).toBe(true);

    // План на заказе всё ещё 500₽ (snapshot после startCalculation).
    // Заказ перешёл в CALCULATION_DONE.
    const orderAfterComplete = await t.prisma.order.findUnique({
      where: { id: orderId },
    });
    expect(orderAfterComplete!.status).toBe('CALCULATION_DONE');
    expect(Number(orderAfterComplete!.operationCostPlanRub)).toBeCloseTo(500, 2);
    // costEstimateTotalRub отделено от operationCostPlanRub: оба поля
    // живут на заказе независимо. Себестоимость не зависит от плана
    // операций (LABOR ещё не добавлен).
    expect(orderAfterComplete!.costEstimateTotalRub).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 9. Stale-detection: меняем ставку → DTO детали отдаёт isStale=true.
  // ---------------------------------------------------------------------------

  test('Меняем ставку операции → GET /api/orders/:id отдаёт operationPlanIsStale=true', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-STALE',
      name: 'План STALE',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });
    const route = await createRoute(t, {
      code: 'RT-STALE',
      operationIds: [op.id],
    });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      routeTemplateId: route.id,
    });

    // Изначально freshness OK.
    const fresh = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(fresh.body.operationPlanIsStale).toBe(false);
    expect(fresh.body.operationPlanStaleReason).toBeNull();

    // Меняем `Operation.fixedRate` — touch обновит `Operation.updatedAt`.
    // Делаем небольшую паузу, чтобы updatedAt гарантированно был
    // больше operationPlanCalculatedAt.
    await new Promise((r) => setTimeout(r, 25));
    await t.prisma.operation.update({
      where: { id: op.id },
      data: { fixedRate: new Prisma.Decimal(150) },
    });

    const stale = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(stale.body.operationPlanIsStale).toBe(true);
    expect(stale.body.operationPlanStaleReason).toMatch(
      /менялись операции|ставки|нормы времени/,
    );
    // sourceUpdatedAt должен быть свежее, чем operationPlanCalculatedAt.
    expect(stale.body.operationPlanSourceUpdatedAt).not.toBeNull();
    expect(
      new Date(stale.body.operationPlanSourceUpdatedAt as string).getTime(),
    ).toBeGreaterThan(
      new Date(stale.body.operationPlanCalculatedAt as string).getTime(),
    );

    // Старое значение цены не пересчитано — snapshot всё ещё «как было».
    expect(Number(stale.body.operationCostPlanRub)).toBeCloseTo(500, 2);
  });

  // ---------------------------------------------------------------------------
  // 10. Ручной пересчёт: DRAFT → snapshot обновлён, isStale=false.
  // ---------------------------------------------------------------------------

  test('POST /api/orders/:id/operation-plan/recalculate в DRAFT обновляет snapshot', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-RECALC',
      name: 'План RECALC',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });
    const route = await createRoute(t, {
      code: 'RT-RECALC',
      operationIds: [op.id],
    });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      routeTemplateId: route.id,
    });

    // Меняем ставку.
    await new Promise((r) => setTimeout(r, 25));
    await t.prisma.operation.update({
      where: { id: op.id },
      data: { fixedRate: new Prisma.Decimal(200) },
    });

    // Пересчёт.
    const recalc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/operation-plan/recalculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    expect(Number(recalc.body.operationCostPlanRub)).toBeCloseTo(1000, 2); // 5×200
    expect(recalc.body.operationTimePlanSec).toBe(300); // 5×60
    expect(recalc.body.operationPlanIsStale).toBe(false);
    expect(recalc.body.operationPlanStaleReason).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 11. CALCULATION → пересчёт разрешён.
  // ---------------------------------------------------------------------------

  test('Пересчёт разрешён в CALCULATION', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-CALC',
      name: 'План CALC',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });
    const route = await createRoute(t, {
      code: 'RT-CALC',
      operationIds: [op.id],
    });
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-CALC-RECALC',
      name: 'TC',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1' }],
    });
    const pattern = await t.prisma.patternItem.create({
      data: { name: 'Лекало', article: 'P-RECALC-1', status: 'ACTIVE' },
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      routeTemplateId: route.id,
      techCardId: tc.id,
      patternItemId: pattern.id,
    });
    // Запускаем расчёт — заказ переходит в CALCULATION.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const before = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(before!.status).toBe('CALCULATION');

    // Меняем ставку.
    await new Promise((r) => setTimeout(r, 25));
    await t.prisma.operation.update({
      where: { id: op.id },
      data: { fixedRate: new Prisma.Decimal(50) },
    });

    // Пересчёт.
    const recalc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/operation-plan/recalculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    expect(Number(recalc.body.operationCostPlanRub)).toBeCloseTo(250, 2);
  });

  // ---------------------------------------------------------------------------
  // 12. CALCULATION_DONE → пересчёт запрещён 409 + адресный текст.
  // ---------------------------------------------------------------------------

  test('Пересчёт запрещён в CALCULATION_DONE', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-CD',
      name: 'План CD',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });
    const route = await createRoute(t, {
      code: 'RT-CD',
      operationIds: [op.id],
    });
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-CD-RECALC',
      name: 'TC',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1' }],
    });
    const pattern = await t.prisma.patternItem.create({
      data: { name: 'Лекало', article: 'P-RECALC-CD-1', status: 'ACTIVE' },
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      routeTemplateId: route.id,
      techCardId: tc.id,
      patternItemId: pattern.id,
    });
    // CALCULATION + complete-calculation → CALCULATION_DONE.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const needs = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    for (const need of needs) {
      await t.prisma.workshopNeed.update({
        where: { id: need.id },
        data: {
          purchaseQty: need.calculatedQty ?? new Prisma.Decimal(1),
          quotedPrice: new Prisma.Decimal(10),
          quotedCurrency: 'RUB',
          status: 'PURCHASE_PLANNED',
        },
      });
    }
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    // Пересчёт → 409 + понятный текст для UI.
    const recalc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/operation-plan/recalculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(409);
    expect(recalc.body.code).toBe(
      'ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED',
    );
    expect(recalc.body.message).toMatch(/верните заказ на просчёт/);
  });

  // ---------------------------------------------------------------------------
  // 13. IN_PRODUCTION → пересчёт запрещён 409.
  // ---------------------------------------------------------------------------

  test('Пересчёт запрещён в IN_PRODUCTION', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-PROD',
      name: 'План PROD',
      pricingMode: 'FIXED',
      fixedRate: 100,
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });
    const route = await createRoute(t, {
      code: 'RT-PROD',
      operationIds: [op.id],
    });
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-PROD-RECALC',
      name: 'TC',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1' }],
    });
    const pattern = await t.prisma.patternItem.create({
      data: { name: 'Лекало', article: 'P-RECALC-PROD-1', status: 'ACTIVE' },
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      routeTemplateId: route.id,
      techCardId: tc.id,
      patternItemId: pattern.id,
    });
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);
    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('IN_PRODUCTION');

    const recalc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/operation-plan/recalculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(409);
    expect(recalc.body.code).toBe(
      'ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED',
    );
  });

  // ---------------------------------------------------------------------------
  // 14. Без маршрута: пересчёт не падает, snapshot=null + warning.
  // ---------------------------------------------------------------------------

  test('Пересчёт без маршрута: snapshot=null + warning, action не падает', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: null,
    });

    // Пересчёт.
    const recalc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/operation-plan/recalculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    expect(recalc.body.operationCostPlanRub).toBeNull();
    expect(recalc.body.operationTimePlanSec).toBeNull();
    expect(recalc.body.operationPlanWarnings).toEqual([
      'Маршрут не выбран — план операций не рассчитан',
    ]);
  });

  // ---------------------------------------------------------------------------
  // 15. Этап «План операций до запуска»: route steps snapshot материализуется
  //     в DRAFT/CALCULATION, а не в start().
  // ---------------------------------------------------------------------------

  test('create order с маршрутом → OrderRouteStep[] виден сразу в DRAFT', async () => {
    // До этого изменения snapshot шагов появлялся только в `start()`,
    // и обе вкладки карточки заказа («Операции», «Сводно по заказу»)
    // были пустыми в DRAFT/CALCULATION даже когда
    // `Order.operationCostPlanRub` уже был посчитан. Теперь вкладка
    // «Операции» показывает строки сразу после создания заказа с
    // выбранным маршрутом.
    const op1 = await createOperation(t, {
      code: 'PLAN-RT-CR-1',
      name: 'Шаг 1',
      pricingMode: 'FIXED',
      fixedRate: 30,
      timeNormMode: 'FIXED',
      timeNormSec: 40,
    });
    const op2 = await createOperation(t, {
      code: 'PLAN-RT-CR-2',
      name: 'Шаг 2',
      pricingMode: 'FIXED',
      fixedRate: 70,
      timeNormMode: 'FIXED',
      timeNormSec: 60,
    });
    const route = await createRoute(t, {
      code: 'RT-PLAN-CR',
      operationIds: [op1.id, op2.id],
    });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
      routeTemplateId: route.id,
    });

    const order = await t.prisma.order.findUnique({
      where: { id: orderId },
    });
    expect(order!.status).toBe('DRAFT');
    // Заказ остаётся в DRAFT, но snapshot шагов уже есть.
    const steps = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(steps.map((s) => ({ index: s.index, operationId: s.operationId })))
      .toEqual([
        { index: 0, operationId: op1.id },
        { index: 1, operationId: op2.id },
      ]);

    // GET /api/orders/:id отдаёт routeSteps в DTO до запуска.
    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(detail.body.routeSteps).toHaveLength(2);
    expect(detail.body.routeSteps[0].operationCode).toBe('PLAN-RT-CR-1');

    // Стоимость операций тоже считается в DRAFT (4*30 + 4*70 = 400).
    expect(Number(order!.operationCostPlanRub)).toBeCloseTo(400, 2);
    expect(order!.operationTimePlanSec).toBe(400); // 4*40 + 4*60
  });

  test('update DRAFT routeTemplateId: smy snapshot пересоздаётся под новый шаблон', async () => {
    const opA = await createOperation(t, {
      code: 'PLAN-SWAP-A',
      name: 'A',
      pricingMode: 'FIXED',
      fixedRate: 10,
      timeNormMode: 'FIXED',
      timeNormSec: 30,
    });
    const opB = await createOperation(t, {
      code: 'PLAN-SWAP-B',
      name: 'B',
      pricingMode: 'FIXED',
      fixedRate: 20,
      timeNormMode: 'FIXED',
      timeNormSec: 50,
    });
    const routeA = await createRoute(t, {
      code: 'RT-SWAP-A',
      operationIds: [opA.id],
    });
    const routeB = await createRoute(t, {
      code: 'RT-SWAP-B',
      operationIds: [opB.id, opA.id],
    });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      routeTemplateId: routeA.id,
    });

    const stepsA = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(stepsA.map((s) => s.operationId)).toEqual([opA.id]);

    // Переключаем шаблон на routeB (DRAFT, разрешено).
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .send({ routeTemplateId: routeB.id })
      .expect(200);

    const stepsB = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(stepsB.map((s) => s.operationId)).toEqual([opB.id, opA.id]);

    // Стоимость пересчитана: 2*(20 + 10) = 60, время: 2*(50 + 30) = 160.
    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(Number(order!.operationCostPlanRub)).toBeCloseTo(60, 2);
    expect(order!.operationTimePlanSec).toBe(160);
  });

  test('update DRAFT routeTemplateId=null: snapshot шагов вычищается', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-UNSET',
      name: 'UNSET',
      pricingMode: 'FIXED',
      fixedRate: 10,
      timeNormMode: 'FIXED',
      timeNormSec: 30,
    });
    const route = await createRoute(t, {
      code: 'RT-UNSET',
      operationIds: [op.id],
    });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      routeTemplateId: route.id,
    });
    expect(
      await t.prisma.orderRouteStep.count({ where: { orderId } }),
    ).toBe(1);

    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .send({ routeTemplateId: null })
      .expect(200);

    expect(
      await t.prisma.orderRouteStep.count({ where: { orderId } }),
    ).toBe(0);
    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.routeTemplateId).toBeNull();
    // План тоже пересчитан → null + warning.
    expect(order!.operationCostPlanRub).toBeNull();
    expect(order!.operationTimePlanSec).toBeNull();
  });

  test('manual recalculate синхронизирует snapshot после правки шагов шаблона', async () => {
    // Менеджер переключил шаги маршрута в admin /admin/routes ПОСЛЕ
    // создания заказа. Snapshot заказа стал stale, кнопка
    // «Пересчитать план операций» обязана и стоимость пересчитать,
    // и шаги обновить — иначе вкладка «Операции» продолжит показывать
    // старый порядок.
    const opA = await createOperation(t, {
      code: 'PLAN-RC-A',
      name: 'A',
      pricingMode: 'FIXED',
      fixedRate: 10,
      timeNormMode: 'FIXED',
      timeNormSec: 30,
    });
    const opB = await createOperation(t, {
      code: 'PLAN-RC-B',
      name: 'B',
      pricingMode: 'FIXED',
      fixedRate: 20,
      timeNormMode: 'FIXED',
      timeNormSec: 50,
    });
    const route = await createRoute(t, {
      code: 'RT-RC',
      operationIds: [opA.id],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      routeTemplateId: route.id,
    });
    expect(
      (await t.prisma.orderRouteStep.findMany({ where: { orderId } })).length,
    ).toBe(1);

    // Меняем шаги шаблона напрямую через Prisma, чтобы это не
    // потребовало нового UI (имитируем admin-правку маршрута).
    await t.prisma.routeTemplateStep.deleteMany({
      where: { templateId: route.id },
    });
    await t.prisma.routeTemplateStep.createMany({
      data: [
        { templateId: route.id, index: 0, operationId: opB.id },
        { templateId: route.id, index: 1, operationId: opA.id },
      ],
    });

    // Ручной пересчёт.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/operation-plan/recalculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    const stepsAfter = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(stepsAfter.map((s) => s.operationId)).toEqual([opB.id, opA.id]);
  });

  test('start() не пересоздаёт snapshot, если он уже был зафиксирован в DRAFT', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-STBL',
      name: 'STBL',
      pricingMode: 'FIXED',
      fixedRate: 10,
      timeNormMode: 'FIXED',
      timeNormSec: 30,
    });
    const route = await createRoute(t, {
      code: 'RT-STBL',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      routeTemplateId: route.id,
    });

    const beforeStart = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(beforeStart).toHaveLength(1);
    const stableId = beforeStart[0].id;

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const afterStart = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(afterStart).toHaveLength(1);
    // Тот же row — snapshot не перезатёрт. Это критично:
    // `Passport.currentRouteStepIndex` ссылается на index в snapshot,
    // и пересоздание строк нарушит инвариант ADR-0006 «после запуска
    // план иммутабелен».
    expect(afterStart[0].id).toBe(stableId);
  });

  test('start() как defensive fallback: создаёт snapshot для legacy-заказа без него', async () => {
    // Эмулируем старый заказ, который был создан до этой фичи и
    // приехал в start() без `OrderRouteStep[]`. Для этого создаём
    // заказ через API, потом удаляем snapshot напрямую через Prisma.
    const op = await createOperation(t, {
      code: 'PLAN-LEG',
      name: 'LEG',
      pricingMode: 'FIXED',
      fixedRate: 10,
      timeNormMode: 'FIXED',
      timeNormSec: 30,
    });
    const route = await createRoute(t, {
      code: 'RT-LEG',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      routeTemplateId: route.id,
    });
    await t.prisma.orderRouteStep.deleteMany({ where: { orderId } });

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const afterStart = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
    });
    expect(afterStart).toHaveLength(1);
    expect(afterStart[0].operationId).toBe(op.id);
  });

  test('IN_PRODUCTION: расчёт плана отказан, маршрут не меняется, snapshot immutable', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-IM',
      name: 'IM',
      pricingMode: 'FIXED',
      fixedRate: 10,
      timeNormMode: 'FIXED',
      timeNormSec: 30,
    });
    const route = await createRoute(t, {
      code: 'RT-IM',
      operationIds: [op.id],
    });
    const route2 = await createRoute(t, {
      code: 'RT-IM-ALT',
      operationIds: [op.id, op.id].slice(0, 1),
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      routeTemplateId: route.id,
    });
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);
    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('IN_PRODUCTION');

    // Смена шаблона запрещена общим ORDER_LOCKED guard.
    const swap = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .send({ routeTemplateId: route2.id });
    expect(swap.status).toBe(409);
    expect(swap.body.code).toBe('ORDER_LOCKED');

    // Manual recalc запрещён на IN_PRODUCTION.
    const recalc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/operation-plan/recalculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(409);
    expect(recalc.body.code).toBe('ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED');

    // Snapshot шагов не тронут.
    const steps = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].operationId).toBe(op.id);
  });

  // ---------------------------------------------------------------------------
  // 16. Edge case (после переноса OrderRouteStep[] snapshot в DRAFT):
  //     PATCH /api/routes/:id { steps } помечает зависимый заказ stale.
  //     `RoutesService.update` обязан touch-нуть `RouteTemplate.updatedAt`
  //     даже когда в data приходит только `steps`. Иначе
  //     `OrderOperationPlanService.getFreshnessForOrder` не увидел бы
  //     изменения (он смотрит на `RouteTemplate.updatedAt`, а
  //     `RouteTemplateStep.updatedAt` в схеме нет).
  // ---------------------------------------------------------------------------

  test('PATCH /api/routes/:id { steps } touch-ит RouteTemplate.updatedAt и помечает order stale', async () => {
    const opA = await createOperation(t, {
      code: 'PLAN-PATCH-A',
      name: 'A',
      pricingMode: 'FIXED',
      fixedRate: 10,
      timeNormMode: 'FIXED',
      timeNormSec: 30,
    });
    const opB = await createOperation(t, {
      code: 'PLAN-PATCH-B',
      name: 'B',
      pricingMode: 'FIXED',
      fixedRate: 20,
      timeNormMode: 'FIXED',
      timeNormSec: 50,
    });

    // Создаём шаблон через API, чтобы получить «честный» updatedAt.
    const tplResp = await request(t.app.getHttpServer())
      .post('/api/routes')
      .set('Cookie', cookies.manager)
      .send({
        code: 'RT-PATCH-STEPS',
        name: 'RT-PATCH-STEPS',
        steps: [{ operationId: opA.id }],
      })
      .expect(201);
    const tplId: string = tplResp.body.id;

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      routeTemplateId: tplId,
    });

    const fresh = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(fresh.body.operationPlanIsStale).toBe(false);

    // PATCH ровно `{steps: [...]}`, без `name/code/isActive` — только
    // этот узкий случай раньше не touch-ил `RouteTemplate.updatedAt`.
    await new Promise((r) => setTimeout(r, 25));
    await request(t.app.getHttpServer())
      .patch(`/api/routes/${tplId}`)
      .set('Cookie', cookies.manager)
      .send({ steps: [{ operationId: opB.id }, { operationId: opA.id }] })
      .expect(200);

    // RouteTemplate.updatedAt действительно сдвинулся вперёд.
    const tplAfter = await t.prisma.routeTemplate.findUnique({
      where: { id: tplId },
    });
    expect(tplAfter!.updatedAt.getTime()).toBeGreaterThan(
      new Date(tplResp.body.updatedAt as string).getTime(),
    );

    // Заказ помечен stale → ActionCenter / OrderOperationsTab нарисуют
    // подсказку «План операций требует пересчёта».
    const stale = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(stale.body.operationPlanIsStale).toBe(true);
    expect(stale.body.operationPlanStaleReason).toMatch(
      /менялись операции|ставки|нормы времени/,
    );

    // После manual recalculate snapshot OrderRouteStep[] обновляется
    // под новые шаги шаблона (ровно тот контракт, который требует
    // edge-case-проверка: «после recalculate OrderRouteStep[]
    // обновляется»). Сценарий зеркалит test 15 («manual recalculate
    // синхронизирует snapshot после правки шагов шаблона»), но идёт
    // через PATCH API маршрута, а не через прямой Prisma-doctor.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/operation-plan/recalculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    const stepsAfter = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(stepsAfter.map((s) => s.operationId)).toEqual([opB.id, opA.id]);

    const refreshed = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(refreshed.body.operationPlanIsStale).toBe(false);
    expect(refreshed.body.operationPlanStaleReason).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 17. Edge case: `syncOrderRouteStepsSnapshot` остаётся silent no-op
  //     ровно в одном случае — `Order.routeTemplateId` отсутствует.
  //     Удаление шаблона через DB (`ON DELETE SET NULL` в миграции
  //     `20260425100000_add_production_routes`) опускает связь
  //     заказа в null, после чего recalculate штатно отдаёт snapshot=
  //     null + warning «Маршрут не выбран» — это и есть допустимый
  //     no-op. Source-уровневая проверка «никаких try/catch вокруг
  //     route-service / БД-вызовов в helper-е» живёт в смоке
  //     `tests/smoke/order-route-snapshot.smoke.test.ts`.
  // ---------------------------------------------------------------------------

  test('syncOrderRouteStepsSnapshot: удаление шаблона через DB (SET NULL) → snapshot пустой, recalculate возвращает warning', async () => {
    const op = await createOperation(t, {
      code: 'PLAN-MISS-OP',
      name: 'MISS',
      pricingMode: 'FIXED',
      fixedRate: 10,
      timeNormMode: 'FIXED',
      timeNormSec: 30,
    });
    const route = await createRoute(t, {
      code: 'RT-MISS',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      routeTemplateId: route.id,
    });

    // Удаляем шаблон через DB. Order.routeTemplateId по FK
    // `ON DELETE SET NULL` (см. миграцию production-routes)
    // обнуляется. Это санкционированный legacy-сценарий «шаблон
    // удалили на админ-панели», и helper обязан вытереть snapshot,
    // а не throw-нуть.
    await t.prisma.routeTemplateStep.deleteMany({
      where: { templateId: route.id },
    });
    await t.prisma.routeTemplate.delete({ where: { id: route.id } });

    // После DB-cascade у заказа routeTemplateId стал null.
    const afterCascade = await t.prisma.order.findUnique({
      where: { id: orderId },
    });
    expect(afterCascade!.routeTemplateId).toBeNull();

    // Manual recalculate отрабатывает штатно: snapshot=null,
    // warning «Маршрут не выбран», OrderRouteStep[] вычищены.
    const recalc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/operation-plan/recalculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    expect(recalc.body.operationCostPlanRub).toBeNull();
    expect(recalc.body.operationTimePlanSec).toBeNull();
    expect(recalc.body.operationPlanWarnings).toEqual([
      'Маршрут не выбран — план операций не рассчитан',
    ]);
    expect(
      await t.prisma.orderRouteStep.count({ where: { orderId } }),
    ).toBe(0);
  });
});

// ===========================================================================
// helpers
// ===========================================================================

async function createOperation(
  t: TestApp,
  options: {
    code: string;
    name: string;
    pricingMode: 'FIXED' | 'BY_SIZE' | 'SALARY_ONLY';
    fixedRate?: number | null;
    ratesBySize?: Array<{ sizeId: string; rate: number }>;
    timeNormMode: 'FIXED' | 'BY_SIZE';
    timeNormSec?: number | null;
    timeNormsBySize?: Array<{ sizeId: string; seconds: number }>;
  },
): Promise<{ id: string }> {
  // Создаём напрямую через Prisma, чтобы не тащить через Zod-валидаторы
  // CreateOperationSchema (тестируем сервис плана, а не CRUD операций).
  const op = await t.prisma.operation.create({
    data: {
      code: options.code,
      name: options.name,
      category: 'SEWING',
      sortOrder: 1000 + Math.floor(Math.random() * 100000),
      active: true,
      pricingMode: options.pricingMode,
      fixedRate:
        options.pricingMode === 'FIXED' && options.fixedRate != null
          ? new Prisma.Decimal(options.fixedRate)
          : null,
      timeNormMode: options.timeNormMode,
      timeNormSec:
        options.timeNormMode === 'FIXED' && options.timeNormSec != null
          ? options.timeNormSec
          : null,
    },
  });
  if (options.pricingMode === 'BY_SIZE' && options.ratesBySize?.length) {
    await t.prisma.operationRateBySize.createMany({
      data: options.ratesBySize.map((r) => ({
        operationId: op.id,
        sizeId: r.sizeId,
        rate: new Prisma.Decimal(r.rate),
      })),
    });
  }
  if (options.timeNormMode === 'BY_SIZE' && options.timeNormsBySize?.length) {
    await t.prisma.operationTimeNormBySize.createMany({
      data: options.timeNormsBySize.map((tn) => ({
        operationId: op.id,
        sizeId: tn.sizeId,
        seconds: tn.seconds,
      })),
    });
  }
  return { id: op.id };
}

async function createRoute(
  t: TestApp,
  options: { code: string; operationIds: string[] },
): Promise<{ id: string }> {
  const r = await t.prisma.routeTemplate.create({
    data: {
      code: options.code,
      name: `Route ${options.code}`,
      isActive: true,
      steps: {
        create: options.operationIds.map((operationId, index) => ({
          index,
          operationId,
          isOptional: false,
        })),
      },
    },
  });
  return { id: r.id };
}

async function createOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  options: {
    items: Array<{ sizeId: string; qtyPlan: number }>;
    routeTemplateId?: string | null;
    techCardId?: string | null;
    patternItemId?: string | null;
  },
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      clientId: seed.client.id,
      productId: seed.product.id,
      items: options.items,
      routeTemplateId: options.routeTemplateId ?? undefined,
      techCardId: options.techCardId ?? undefined,
      patternItemId: options.patternItemId ?? undefined,
    })
    .expect(201);
  return r.body.id as string;
}

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
