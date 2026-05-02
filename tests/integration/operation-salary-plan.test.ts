/**
 * Integration-тесты для «Плановой стоимости окладных операций»
 * (см. ТЗ «Плановая стоимость окладных операций по нормам времени»).
 *
 * Что покрываем:
 *   1. SALARY_ONLY с timeNormSec=120, salaryPlanRubPerShift=3200,
 *      shiftSeconds=28800, qty=10 → cost ≈ 133.33₽, time = 1200с.
 *   2. SALARY_ONLY без salaryPlanRubPerShift → cost = 0, time = qty×120,
 *      warning «Не задана плановая окладная ставка».
 *   3. FIXED / BY_SIZE считаются как раньше (regression: salaryPlan-поля
 *      на них не влияют, даже если заданы).
 *   4. Обновление salaryPlanRubPerShift через `Operation.update`
 *      → snapshot заказа становится stale (Operation.updatedAt свежее).
 *
 * Что НЕ проверяем здесь:
 *   - формы UI (smoke `operation-salary-plan.smoke.test.ts`);
 *   - payroll/Passport (этот этап их не трогает; историческая
 *     таблица PieceRate удалена в PHASE 2 STEP 1, ставки живут
 *     в Operation.fixedRate / OperationRateBySize);
 *   - completeCalculation / LABOR (это отдельный этап, см.
 *     `order-cost-estimates.test.ts`).
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

describeWithDb(
  'integration — operation salary plan (плановая стоимость окладных)',
  () => {
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

    // -----------------------------------------------------------------------
    // 1. SALARY_ONLY + timeNormSec + salaryPlanRubPerShift → план считается
    // -----------------------------------------------------------------------

    test('SALARY_ONLY 120с × 10 шт × 3200₽/28800с ≈ 133.33₽ (cost), 1200с (time)', async () => {
      const op = await createSalaryOperation(t, {
        code: 'SAL-PLAN-1',
        name: 'Окладная план 1',
        timeNormSec: 120,
        salaryPlanRubPerShift: 3200,
        salaryPlanShiftSeconds: 28800,
      });
      const route = await createRoute(t, {
        code: 'RT-SAL-PLAN-1',
        operationIds: [op.id],
      });

      const orderId = await createOrder(t, seed, cookies.manager, {
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        routeTemplateId: route.id,
      });

      const order = await t.prisma.order.findUnique({ where: { id: orderId } });
      expect(order).not.toBeNull();
      // cost = 10 × 120 × (3200 / 28800) = 1200 × 0.111... ≈ 133.33
      expect(Number(order!.operationCostPlanRub)).toBeCloseTo(
        (10 * 120 * 3200) / 28800,
        2,
      );
      // С округлением Decimal(14,2) HALF_UP — точный snapshot 133.33₽.
      expect(order!.operationCostPlanRub?.toString()).toBe('133.33');
      expect(order!.operationTimePlanSec).toBe(1200);
      expect(order!.operationPlanWarnings).toBeNull();
    });

    test('SALARY_ONLY с длительностью смены 7ч (25200с) считает иначе', async () => {
      const op = await createSalaryOperation(t, {
        code: 'SAL-PLAN-7H',
        name: 'Окладная план 7ч',
        timeNormSec: 60,
        salaryPlanRubPerShift: 2520, // 0.10 ₽/сек
        salaryPlanShiftSeconds: 25200, // 7 часов
      });
      const route = await createRoute(t, {
        code: 'RT-SAL-7H',
        operationIds: [op.id],
      });
      const orderId = await createOrder(t, seed, cookies.manager, {
        items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
        routeTemplateId: route.id,
      });
      const order = await t.prisma.order.findUnique({ where: { id: orderId } });
      // cost = 5 × 60 × (2520 / 25200) = 300 × 0.10 = 30
      expect(Number(order!.operationCostPlanRub)).toBeCloseTo(30, 2);
      expect(order!.operationTimePlanSec).toBe(300);
    });

    // -----------------------------------------------------------------------
    // 2. SALARY_ONLY без плановой ставки → cost = 0, warning, time считается
    // -----------------------------------------------------------------------

    test('SALARY_ONLY без salaryPlanRubPerShift → cost=0, time=600, warning', async () => {
      const op = await createSalaryOperation(t, {
        code: 'SAL-NORATE',
        name: 'Окладная без ставки',
        timeNormSec: 60,
        salaryPlanRubPerShift: null,
      });
      const route = await createRoute(t, {
        code: 'RT-SAL-NORATE',
        operationIds: [op.id],
      });

      const orderId = await createOrder(t, seed, cookies.manager, {
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        routeTemplateId: route.id,
      });

      const order = await t.prisma.order.findUnique({ where: { id: orderId } });
      // Стоимость окладной без плановой ставки = 0.
      expect(Number(order!.operationCostPlanRub)).toBe(0);
      // Время по-прежнему считается (10 × 60 = 600).
      expect(order!.operationTimePlanSec).toBe(600);
      // Warning о пропущенной плановой окладной ставке.
      const warnings = order!.operationPlanWarnings as string[];
      expect(warnings).not.toBeNull();
      expect(
        warnings.some((w) =>
          w.includes('Не задана плановая окладная ставка'),
        ),
      ).toBe(true);
      // Заказ не упал — статус DRAFT.
      expect(order!.status).toBe('DRAFT');
    });

    // -----------------------------------------------------------------------
    // 3. FIXED / BY_SIZE считаются как раньше (regression)
    // -----------------------------------------------------------------------

    test('FIXED-операция игнорирует salaryPlanRubPerShift, считает как было', async () => {
      // Заранее проставляем salaryPlanRubPerShift даже на FIXED, чтобы
      // убедиться, что для FIXED она НЕ применяется.
      const op = await t.prisma.operation.create({
        data: {
          code: 'FIX-WITH-SAL',
          name: 'FIXED с salaryPlan',
          category: 'SEWING',
          sortOrder: 9001,
          active: true,
          pricingMode: 'FIXED',
          fixedRate: new Prisma.Decimal(50),
          timeNormMode: 'FIXED',
          timeNormSec: 120,
          salaryPlanRubPerShift: new Prisma.Decimal(9999),
          salaryPlanShiftSeconds: 28800,
        },
      });
      const route = await createRoute(t, {
        code: 'RT-FIX-SAL',
        operationIds: [op.id],
      });
      const orderId = await createOrder(t, seed, cookies.manager, {
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        routeTemplateId: route.id,
      });
      const order = await t.prisma.order.findUnique({ where: { id: orderId } });
      // Используется FIXED-ставка 50₽ × 10 = 500₽, salaryPlan 9999 не
      // влияет на FIXED.
      expect(Number(order!.operationCostPlanRub)).toBe(500);
      expect(order!.operationTimePlanSec).toBe(1200);
    });

    test('BY_SIZE-операция игнорирует salaryPlanRubPerShift', async () => {
      const op = await t.prisma.operation.create({
        data: {
          code: 'BYSZ-WITH-SAL',
          name: 'BY_SIZE с salaryPlan',
          category: 'SEWING',
          sortOrder: 9002,
          active: true,
          pricingMode: 'BY_SIZE',
          timeNormMode: 'FIXED',
          timeNormSec: 60,
          salaryPlanRubPerShift: new Prisma.Decimal(7777),
          salaryPlanShiftSeconds: 28800,
        },
      });
      await t.prisma.operationRateBySize.create({
        data: {
          operationId: op.id,
          sizeId: seed.sizes.M,
          rate: new Prisma.Decimal(20),
        },
      });
      const route = await createRoute(t, {
        code: 'RT-BYSZ-SAL',
        operationIds: [op.id],
      });
      const orderId = await createOrder(t, seed, cookies.manager, {
        items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
        routeTemplateId: route.id,
      });
      const order = await t.prisma.order.findUnique({ where: { id: orderId } });
      // BY_SIZE: 5 × 20 = 100₽; salaryPlan 7777 НЕ применяется.
      expect(Number(order!.operationCostPlanRub)).toBe(100);
      expect(order!.operationTimePlanSec).toBe(300);
    });

    // -----------------------------------------------------------------------
    // 4. Stale-detection: меняем salaryPlanRubPerShift → план stale
    // -----------------------------------------------------------------------

    test('Изменение salaryPlanRubPerShift делает план заказа stale', async () => {
      const op = await createSalaryOperation(t, {
        code: 'SAL-STALE',
        name: 'Окладная stale',
        timeNormSec: 60,
        salaryPlanRubPerShift: 1000,
        salaryPlanShiftSeconds: 28800,
      });
      const route = await createRoute(t, {
        code: 'RT-SAL-STALE',
        operationIds: [op.id],
      });
      const orderId = await createOrder(t, seed, cookies.manager, {
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        routeTemplateId: route.id,
      });

      // Изначально план свежий.
      const fresh = await request(t.app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Cookie', cookies.manager)
        .expect(200);
      expect(fresh.body.operationPlanIsStale).toBe(false);

      // Меняем salaryPlanRubPerShift — `Operation.updatedAt` обновится.
      await new Promise((r) => setTimeout(r, 25));
      await t.prisma.operation.update({
        where: { id: op.id },
        data: { salaryPlanRubPerShift: new Prisma.Decimal(2000) },
      });

      const stale = await request(t.app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Cookie', cookies.manager)
        .expect(200);
      expect(stale.body.operationPlanIsStale).toBe(true);
      expect(stale.body.operationPlanStaleReason).toMatch(
        /менялись операции|ставки|нормы времени/,
      );

      // Старый snapshot всё ещё показывает 10 × 60 × (1000 / 28800).
      // = 600 × 0.0347... = 20.83
      expect(Number(stale.body.operationCostPlanRub)).toBeCloseTo(
        (10 * 60 * 1000) / 28800,
        2,
      );
    });

    test('Ручной пересчёт после изменения ставки даёт новый snapshot', async () => {
      const op = await createSalaryOperation(t, {
        code: 'SAL-RECALC',
        name: 'Окладная RECALC',
        timeNormSec: 60,
        salaryPlanRubPerShift: 1000,
        salaryPlanShiftSeconds: 28800,
      });
      const route = await createRoute(t, {
        code: 'RT-SAL-RECALC',
        operationIds: [op.id],
      });
      const orderId = await createOrder(t, seed, cookies.manager, {
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        routeTemplateId: route.id,
      });
      // 10 × 60 × 1000 / 28800 = 20.83
      const before = await t.prisma.order.findUnique({ where: { id: orderId } });
      expect(Number(before!.operationCostPlanRub)).toBeCloseTo(
        (10 * 60 * 1000) / 28800,
        2,
      );

      // Удваиваем ставку.
      await new Promise((r) => setTimeout(r, 25));
      await t.prisma.operation.update({
        where: { id: op.id },
        data: { salaryPlanRubPerShift: new Prisma.Decimal(2000) },
      });

      const recalc = await request(t.app.getHttpServer())
        .post(`/api/orders/${orderId}/operation-plan/recalculate`)
        .set('Cookie', cookies.manager)
        .send({})
        .expect(201);
      // 10 × 60 × 2000 / 28800 ≈ 41.67
      expect(Number(recalc.body.operationCostPlanRub)).toBeCloseTo(
        (10 * 60 * 2000) / 28800,
        2,
      );
      expect(recalc.body.operationPlanIsStale).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 5. Payroll / SalaryEntry / OperationEntry не задействованы
    // -----------------------------------------------------------------------

    test('После создания SALARY_ONLY-плана не появляется ни SalaryEntry, ни OperationEntry', async () => {
      const op = await createSalaryOperation(t, {
        code: 'SAL-NO-PAYROLL',
        name: 'Без payroll',
        timeNormSec: 120,
        salaryPlanRubPerShift: 3200,
        salaryPlanShiftSeconds: 28800,
      });
      const route = await createRoute(t, {
        code: 'RT-NO-PAY',
        operationIds: [op.id],
      });
      await createOrder(t, seed, cookies.manager, {
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        routeTemplateId: route.id,
      });

      // План посчитался, но никаких фактических записей — это просто
      // плановая себестоимость, не payroll.
      const opEntries = await t.prisma.operationEntry.count();
      const salEntries = await t.prisma.salaryEntry.count();
      expect(opEntries).toBe(0);
      expect(salEntries).toBe(0);
    });
  },
);

// ===========================================================================
// helpers
// ===========================================================================

async function createSalaryOperation(
  t: TestApp,
  options: {
    code: string;
    name: string;
    timeNormSec: number;
    salaryPlanRubPerShift: number | null;
    salaryPlanShiftSeconds?: number;
  },
): Promise<{ id: string }> {
  const op = await t.prisma.operation.create({
    data: {
      code: options.code,
      name: options.name,
      category: 'SEWING',
      sortOrder: 1000 + Math.floor(Math.random() * 100000),
      active: true,
      pricingMode: 'SALARY_ONLY',
      fixedRate: null,
      timeNormMode: 'FIXED',
      timeNormSec: options.timeNormSec,
      salaryPlanRubPerShift:
        options.salaryPlanRubPerShift != null
          ? new Prisma.Decimal(options.salaryPlanRubPerShift)
          : null,
      salaryPlanShiftSeconds: options.salaryPlanShiftSeconds ?? 28800,
    },
  });
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
  },
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items: options.items,
      routeTemplateId: options.routeTemplateId ?? undefined,
    })
    .expect(201);
  return r.body.id as string;
}
