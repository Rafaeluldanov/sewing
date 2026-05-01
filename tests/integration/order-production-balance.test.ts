/**
 * Integration-тесты «Производственная цепочка» — балансировка по
 * операциям заказа (см.
 * `apps/api/src/modules/orders/order-production-balance.service.ts`,
 * `GET /api/orders/:id/production-balance`).
 *
 * Сценарии:
 *   LINE_BALANCE (default):
 *     1.  Реальный штат (CUTTER=1, SEAMSTRESS=2, QC=1) — bottleneck
 *         QC, recommendedAdditions[0] = QC, gainPerShift > 0.
 *     2.  Симуляция «+1 на QC» (через query) повышает выпуск.
 *     3.  Нет сотрудников по категории — warning, lineThroughput = null.
 *     4.  Optional steps пропускаются.
 *     5.  Заказ без маршрута — 200 + warning.
 *     6.  Не пишем в БД, не трогаем OrderCostEstimate.
 *
 *   TARGET_SHIFT (вторичный):
 *     7.  qty=100 → bottleneck=B, output=144;
 *     8.  qty=300 → workers/operation = ceil(workSec/shift);
 *     9.  requiredWorkersTotal / missingWorkersForTargetShift
 *         считаются.
 *
 *   TOTAL_WORKERS / нормы:
 *    10.  totalWorkers=4 — старый режим.
 *    11.  Нет нормы времени → warning, операция не bottleneck.
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

describeWithDb('integration — order production balance', () => {
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

  // -------------------------------------------------------------------------
  // 1. LINE_BALANCE — реальный штат, QC = bottleneck
  // -------------------------------------------------------------------------

  test('LINE_BALANCE (default): реальный штат, bottleneck=QC, рекомендация QC', async () => {
    // CUTTER=1, SEAMSTRESS=2, QC=1 уже есть в seedMinimal.
    // Добавим ещё одну швею, чтобы было 2 на 2 SEWING-операции.
    await addEmployee(t, {
      login: 'seamstress-2',
      role: 'SEAMSTRESS',
      fullName: 'Test Seamstress 2',
    });

    const opCut = await createOperation(t, {
      code: 'PB-LB-CUT',
      name: 'Раскрой',
      category: 'CUTTING',
      timeNormSec: 100, // 100 шт × 100s = 10000
    });
    const opSewA = await createOperation(t, {
      code: 'PB-LB-SEW-A',
      name: 'Шов A',
      category: 'SEWING',
      timeNormSec: 300, // 100 × 300 = 30000
    });
    const opSewB = await createOperation(t, {
      code: 'PB-LB-SEW-B',
      name: 'Шов B',
      category: 'SEWING',
      timeNormSec: 300, // 100 × 300 = 30000
    });
    const opQc = await createOperation(t, {
      code: 'PB-LB-QC',
      name: 'ОТК',
      category: 'QC',
      timeNormSec: 600, // 100 × 600 = 60000
    });
    const route = await createRoute(t, {
      code: 'RT-PB-LB',
      operationIds: [opCut.id, opSewA.id, opSewB.id, opQc.id],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
      routeTemplateId: route.id,
    });

    const resp = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/production-balance`)
      .set('Cookie', cookies.manager)
      .expect(200);

    const dto = resp.body;
    expect(dto.strategy).toBe('LINE_BALANCE');
    expect(dto.availableWorkersTotal).toBe(1 + 2 + 1); // CUT 1 + SEW 2 + QC 1
    // Расстановка не превышает доступных по категориям.
    const cut = dto.lines.find((l: any) => l.operationCode === 'PB-LB-CUT');
    const sewA = dto.lines.find((l: any) => l.operationCode === 'PB-LB-SEW-A');
    const sewB = dto.lines.find((l: any) => l.operationCode === 'PB-LB-SEW-B');
    const qc = dto.lines.find((l: any) => l.operationCode === 'PB-LB-QC');
    expect(cut.assignedWorkers).toBe(1);
    expect(sewA.assignedWorkers).toBe(1);
    expect(sewB.assignedWorkers).toBe(1);
    expect(qc.assignedWorkers).toBe(1);
    expect(cut.assignedWorkers + sewA.assignedWorkers + sewB.assignedWorkers + qc.assignedWorkers)
      .toBe(dto.assignedWorkersTotal);

    // capacityPerShift = floor(workers × 28800 / avgSec)
    // CUT: 1 × 28800 / 100 = 288
    // SEW A: 1 × 28800 / 300 = 96
    // SEW B: 1 × 28800 / 300 = 96
    // QC: 1 × 28800 / 600 = 48
    expect(cut.capacityPerShift).toBe(288);
    expect(sewA.capacityPerShift).toBe(96);
    expect(sewB.capacityPerShift).toBe(96);
    expect(qc.capacityPerShift).toBe(48);

    // lineThroughputPerShift = min(capacity) = 48
    expect(dto.lineThroughputPerShift).toBe(48);
    expect(dto.expectedOutputPerShift).toBe(48);

    // Bottleneck = QC.
    expect(qc.isBottleneck).toBe(true);
    expect(dto.bottleneckOperationName).toBe('ОТК');

    // idlePercent для CUT: 1 - 48/288 = ~0.833.
    expect(cut.idlePercent).toBeGreaterThan(0.8);
    expect(qc.idlePercent).toBe(0);

    // Рекомендация: добавить на QC, gain > 0.
    expect(dto.recommendedAdditions.length).toBe(1);
    const rec = dto.recommendedAdditions[0];
    expect(rec.operationCategory).toBe('QC');
    expect(rec.gainPerShift).toBeGreaterThan(0);
    expect(rec.expectedOutputPerShift).toBeGreaterThan(rec.currentOutputPerShift);
    expect(qc.recommendedToAddWorker).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Симуляция +1 на QC через дополнительного сотрудника даёт прирост
  // -------------------------------------------------------------------------

  test('LINE_BALANCE: добавление 2-го QC увеличивает выпуск', async () => {
    await addEmployee(t, {
      login: 'qc-2',
      role: 'QC',
      fullName: 'Test QC 2',
    });

    const opCut = await createOperation(t, {
      code: 'PB-LB2-CUT',
      name: 'Раскрой',
      category: 'CUTTING',
      timeNormSec: 100,
    });
    const opQc = await createOperation(t, {
      code: 'PB-LB2-QC',
      name: 'ОТК',
      category: 'QC',
      timeNormSec: 600,
    });
    const route = await createRoute(t, {
      code: 'RT-PB-LB2',
      operationIds: [opCut.id, opQc.id],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
      routeTemplateId: route.id,
    });

    const resp = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/production-balance`)
      .set('Cookie', cookies.manager)
      .expect(200);

    // 2 QC → одной операции QC даём 2 сотрудников.
    // capacity QC = floor(2 × 28800 / 600) = 96.
    // capacity CUT = floor(1 × 28800 / 100) = 288.
    // line = min(288, 96) = 96.
    expect(resp.body.lineThroughputPerShift).toBe(96);
    const qc = resp.body.lines.find((l: any) => l.operationCode === 'PB-LB2-QC');
    expect(qc.assignedWorkers).toBe(2);
    expect(qc.capacityPerShift).toBe(96);
    expect(qc.isBottleneck).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Нет сотрудников по категории — warning + lineThroughput=null
  // -------------------------------------------------------------------------

  test('LINE_BALANCE: нет сотрудников категории → warning, line=null', async () => {
    // Деактивируем единственного раскройщика.
    await t.prisma.employee.updateMany({
      where: { role: 'CUTTER' },
      data: { active: false },
    });

    const opCut = await createOperation(t, {
      code: 'PB-LB3-CUT',
      name: 'Раскрой',
      category: 'CUTTING',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-PB-LB3',
      operationIds: [opCut.id],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 50 }],
      routeTemplateId: route.id,
    });

    const resp = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/production-balance`)
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(resp.body.lineThroughputPerShift).toBeNull();
    expect(resp.body.warnings.join(' ')).toMatch(
      /Невозможно оценить выпуск|Нет активных сотрудников/,
    );
    const cut = resp.body.lines.find(
      (l: any) => l.operationCode === 'PB-LB3-CUT',
    );
    expect(cut.assignedWorkers).toBe(0);
    expect(cut.capacityPerShift).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. Optional route step пропускается
  // -------------------------------------------------------------------------

  test('Optional route step не участвует в расчёте', async () => {
    const opMain = await createOperation(t, {
      code: 'PB-OPT-M',
      name: 'Основная',
      category: 'CUTTING',
      timeNormSec: 100,
    });
    const opOpt = await createOperation(t, {
      code: 'PB-OPT-O',
      name: 'Опц',
      category: 'CUTTING',
      timeNormSec: 999999,
    });
    const route = await t.prisma.routeTemplate.create({
      data: {
        code: 'RT-PB-OPT',
        name: 'Optional route',
        isActive: true,
        steps: {
          create: [
            { index: 0, operationId: opMain.id, isOptional: false },
            { index: 1, operationId: opOpt.id, isOptional: true },
          ],
        },
      },
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: route.id,
    });

    const resp = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/production-balance`)
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(resp.body.lines).toHaveLength(1);
    expect(resp.body.lines[0].operationCode).toBe('PB-OPT-M');
  });

  // -------------------------------------------------------------------------
  // 5. Заказ без маршрута
  // -------------------------------------------------------------------------

  test('Заказ без маршрута → lines=[], warning «Маршрут не выбран»', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      routeTemplateId: null,
    });

    const resp = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/production-balance`)
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(resp.body.lines).toEqual([]);
    expect(resp.body.expectedOutputPerShift).toBeNull();
    expect(resp.body.bottleneckOperationName).toBeNull();
    expect(resp.body.warnings.join(' ')).toMatch(/Маршрут не выбран/);
  });

  // -------------------------------------------------------------------------
  // 6. Не пишем в БД, не трогаем OrderCostEstimate
  // -------------------------------------------------------------------------

  test('Балансировка не пишет в БД и не трогает OrderCostEstimate', async () => {
    const op = await createOperation(t, {
      code: 'PB-NOWRITE',
      name: 'Op A',
      category: 'CUTTING',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-PB-NOWRITE',
      operationIds: [op.id],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      routeTemplateId: route.id,
    });

    const before = await t.prisma.order.findUnique({ where: { id: orderId } });
    const beforeCostPlan = before!.operationCostPlanRub
      ? before!.operationCostPlanRub.toString()
      : null;
    const beforeUpdatedAt = before!.updatedAt;
    const beforeEstimate = await t.prisma.orderCostEstimate.findFirst({
      where: { orderId },
    });

    await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/production-balance`)
      .set('Cookie', cookies.manager)
      .expect(200);

    const after = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(after!.updatedAt.getTime()).toBe(beforeUpdatedAt.getTime());
    expect(
      after!.operationCostPlanRub
        ? after!.operationCostPlanRub.toString()
        : null,
    ).toBe(beforeCostPlan);

    const afterEstimate = await t.prisma.orderCostEstimate.findFirst({
      where: { orderId },
    });
    expect(afterEstimate?.id ?? null).toBe(beforeEstimate?.id ?? null);
  });

  // -------------------------------------------------------------------------
  // 7. TARGET_SHIFT — qty=100, A=100s, B=200s
  // -------------------------------------------------------------------------

  test('TARGET_SHIFT: qty=100, A=100s, B=200s → bottleneck=B, output=144', async () => {
    const opA = await createOperation(t, {
      code: 'PB-TS-A',
      name: 'Op A',
      category: 'SEWING',
      timeNormSec: 100,
    });
    const opB = await createOperation(t, {
      code: 'PB-TS-B',
      name: 'Op B',
      category: 'SEWING',
      timeNormSec: 200,
    });
    const route = await createRoute(t, {
      code: 'RT-PB-TS-1',
      operationIds: [opA.id, opB.id],
    });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
      routeTemplateId: route.id,
    });

    const resp = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/production-balance?strategy=TARGET_SHIFT`)
      .set('Cookie', cookies.manager)
      .expect(200);

    const dto = resp.body;
    expect(dto.totalQty).toBe(100);
    expect(dto.shiftSeconds).toBe(28800);
    expect(dto.strategy).toBe('TARGET_SHIFT');
    expect(dto.lines).toHaveLength(2);

    const a = dto.lines.find((l: any) => l.operationCode === 'PB-TS-A');
    const b = dto.lines.find((l: any) => l.operationCode === 'PB-TS-B');
    expect(a.workSec).toBe(100 * 100);
    expect(b.workSec).toBe(100 * 200);
    expect(a.suggestedWorkers).toBe(1); // ceil(10000/28800)
    expect(b.suggestedWorkers).toBe(1); // ceil(20000/28800)
    expect(a.plannedDurationSec).toBe(10000);
    expect(b.plannedDurationSec).toBe(20000);
    expect(a.isBottleneck).toBe(false);
    expect(b.isBottleneck).toBe(true);

    expect(dto.orderPlannedDurationSec).toBe(20000);
    expect(dto.bottleneckOperationName).toBe('Op B');
    expect(dto.expectedOutputPerShift).toBe(
      Math.floor((100 * 28800) / 20000),
    ); // 144

    expect(dto.warnings.join(' ')).toMatch(/Расчёт является плановой оценкой/);
  });

  // -------------------------------------------------------------------------
  // 8. TARGET_SHIFT — qty=300
  // -------------------------------------------------------------------------

  test('TARGET_SHIFT: qty=300 → A workers=2, B workers=3', async () => {
    const opA = await createOperation(t, {
      code: 'PB-TS2-A',
      name: 'Op A',
      category: 'SEWING',
      timeNormSec: 100,
    });
    const opB = await createOperation(t, {
      code: 'PB-TS2-B',
      name: 'Op B',
      category: 'SEWING',
      timeNormSec: 200,
    });
    const route = await createRoute(t, {
      code: 'RT-PB-TS-2',
      operationIds: [opA.id, opB.id],
    });

    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 300 }],
      routeTemplateId: route.id,
    });

    const resp = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/production-balance?strategy=TARGET_SHIFT`)
      .set('Cookie', cookies.manager)
      .expect(200);

    const a = resp.body.lines.find((l: any) => l.operationCode === 'PB-TS2-A');
    const b = resp.body.lines.find((l: any) => l.operationCode === 'PB-TS2-B');
    expect(a.workSec).toBe(30000);
    expect(b.workSec).toBe(60000);
    expect(a.suggestedWorkers).toBe(2);
    expect(b.suggestedWorkers).toBe(3);
    expect(b.isBottleneck).toBe(true);
    expect(resp.body.bottleneckOperationName).toBe('Op B');
  });

  // -------------------------------------------------------------------------
  // 9. TARGET_SHIFT — required vs available
  // -------------------------------------------------------------------------

  test('TARGET_SHIFT: requiredWorkersTotal и missingWorkersForTargetShift', async () => {
    const opA = await createOperation(t, {
      code: 'PB-REQ-A',
      name: 'Op A',
      category: 'SEWING',
      timeNormSec: 200,
    });
    const opB = await createOperation(t, {
      code: 'PB-REQ-B',
      name: 'Op B',
      category: 'QC',
      timeNormSec: 300,
    });
    const route = await createRoute(t, {
      code: 'RT-PB-REQ',
      operationIds: [opA.id, opB.id],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 1000 }],
      routeTemplateId: route.id,
    });

    const resp = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/production-balance?strategy=TARGET_SHIFT`)
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(resp.body.strategy).toBe('TARGET_SHIFT');
    expect(typeof resp.body.requiredWorkersTotal).toBe('number');
    expect(resp.body.requiredWorkersTotal).toBeGreaterThan(0);
    expect(typeof resp.body.availableWorkersTotal).toBe('number');
    expect(typeof resp.body.missingWorkersForTargetShift).toBe('number');
    expect(resp.body.missingWorkersForTargetShift).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // 10. TOTAL_WORKERS — старый режим
  // -------------------------------------------------------------------------

  test('TOTAL_WORKERS: explicit totalWorkers=4 → жадное распределение', async () => {
    const opA = await createOperation(t, {
      code: 'PB-TW-A',
      name: 'Op A',
      category: 'SEWING',
      timeNormSec: 100,
    });
    const opB = await createOperation(t, {
      code: 'PB-TW-B',
      name: 'Op B',
      category: 'SEWING',
      timeNormSec: 200,
    });
    const route = await createRoute(t, {
      code: 'RT-PB-TW',
      operationIds: [opA.id, opB.id],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 300 }],
      routeTemplateId: route.id,
    });

    const resp = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/production-balance?totalWorkers=4`)
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(resp.body.strategy).toBe('TOTAL_WORKERS');
    expect(resp.body.totalWorkers).toBe(4);

    const a = resp.body.lines.find((l: any) => l.operationCode === 'PB-TW-A');
    const b = resp.body.lines.find((l: any) => l.operationCode === 'PB-TW-B');
    expect(a.suggestedWorkers + b.suggestedWorkers).toBe(4);
    const longestPlanned = Math.max(a.plannedDurationSec, b.plannedDurationSec);
    expect(resp.body.orderPlannedDurationSec).toBe(longestPlanned);
  });

  // -------------------------------------------------------------------------
  // 11. Нет нормы времени — warning, операция не bottleneck
  // -------------------------------------------------------------------------

  test('Нет нормы времени → warning, операция не bottleneck', async () => {
    const opNo = await createOperation(t, {
      code: 'PB-NO-N',
      name: 'Без нормы',
      category: 'SEWING',
      timeNormSec: null,
    });
    const opOk = await createOperation(t, {
      code: 'PB-NO-O',
      name: 'С нормой',
      category: 'SEWING',
      timeNormSec: 100,
    });
    const route = await createRoute(t, {
      code: 'RT-PB-NO',
      operationIds: [opNo.id, opOk.id],
    });
    const orderId = await createOrder(t, seed, cookies.manager, {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 50 }],
      routeTemplateId: route.id,
    });

    const resp = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/production-balance?strategy=TARGET_SHIFT`)
      .set('Cookie', cookies.manager)
      .expect(200);

    const noLine = resp.body.lines.find(
      (l: any) => l.operationCode === 'PB-NO-N',
    );
    const okLine = resp.body.lines.find(
      (l: any) => l.operationCode === 'PB-NO-O',
    );
    expect(noLine.workSec).toBe(0);
    expect(noLine.suggestedWorkers).toBe(0);
    expect(noLine.isBottleneck).toBe(false);
    expect(noLine.warnings.join(' ')).toMatch(/Нет нормы времени/);
    expect(okLine.workSec).toBe(50 * 100);
    expect(okLine.isBottleneck).toBe(true);
    expect(resp.body.bottleneckOperationName).toBe('С нормой');
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
    category?: 'CUTTING' | 'SEWING' | 'QC' | 'IRONING' | 'PACKING';
    timeNormSec: number | null;
  },
): Promise<{ id: string }> {
  const op = await t.prisma.operation.create({
    data: {
      code: options.code,
      name: options.name,
      category: options.category ?? 'SEWING',
      sortOrder: 1000 + Math.floor(Math.random() * 100000),
      active: true,
      pricingMode: 'SALARY_ONLY',
      timeNormMode: 'FIXED',
      timeNormSec: options.timeNormSec,
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

async function addEmployee(
  t: TestApp,
  options: {
    login: string;
    fullName: string;
    role:
      | 'CUTTER'
      | 'CUTTER_ASSISTANT'
      | 'SEAMSTRESS'
      | 'QC'
      | 'IRONING'
      | 'PACKING';
  },
): Promise<{ id: string }> {
  const e = await t.prisma.employee.create({
    data: {
      login: options.login,
      fullName: options.fullName,
      role: options.role,
      active: true,
      pinHash: 'test',
    },
  });
  return { id: e.id };
}

void Prisma;
