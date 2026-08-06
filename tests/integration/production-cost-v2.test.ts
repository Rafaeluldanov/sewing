/**
 * Integration-тесты управленческого отчёта «Себестоимость производства v2»
 * (`GET /api/admin/production-cost/v2`).
 *
 * См. recon `docs/production-cost-v2-recon.md`. Старый
 * `/api/costs/production` остаётся как есть и покрыт в
 * `tests/integration/production-cost.test.ts`.
 *
 * Покрытие:
 *
 *   1. Базовый сценарий: пэттерн + заказ + 1 паспорт `qtyPlan = 20`,
 *      несколько `OperationEntry`, упаковка → отчёт показывает:
 *        - operationLines с nomenclatureName, ratePerUnit, amount,
 *          unitCost (`amount / qty`), без обязательного passportNumber;
 *        - nomenclatureGroup с releasedQty = 20 (а НЕ 1 паспорт и НЕ
 *          сумма OperationEntry.qty по операциям);
 *        - operationPieceworkCostRub = Σ OperationEntry.amount;
 *        - unitCostRub = totalCost / 20.
 *   2. Два паспорта под одно лекало → releasedQty суммируется,
 *      одна nomenclatureGroup.
 *   3. Разные паттерны → разные группы.
 *   4. OrderCostEstimate с MATERIAL → materialCostRub учтён
 *      пропорционально выпуску.
 *   5. customerUnitPrice (RUB) × releasedQty → revenueRub корректен,
 *      marginRub = revenue - totalCost.
 *   6. RBAC: ADMIN/SHOP_MANAGER → 200, остальные → 403, без сессии → 401.
 *   7. Источник материалов в orderGroup корректен (COST_ESTIMATE /
 *      WORKSHOP_NEED / NONE).
 *   8. Колонка «Паспорт» не является обязательной: passportId/Number
 *      могут отсутствовать в DTO operationLines (optional technical).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import {
  loginAs,
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — production cost v2 (управленческий отчёт)', () => {
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
    await refreshAdminCookie(t);
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      packer: loginAs(t, seed.employees['packer']),
      admin: t.adminCookie,
    };
  });

  // -------------------------------------------------------------------------
  // 1. Базовый сценарий: 1 паспорт qtyPlan=20, операции, упаковка
  // -------------------------------------------------------------------------

  test('1. Один пэттерн + заказ + паспорт 20 шт + операции → корректные группы и unit cost', async () => {
    const day = utcDay('2026-04-10');
    const pattern = await t.prisma.patternItem.create({
      data: {
        name: 'Худи база',
        article: 'HD-001',
        status: 'ACTIVE',
      },
    });

    const passport = await createPackedPassport(t, seed, {
      qtyPlan: 20,
      qtyGood: 20,
      cutDate: day,
      patternItemId: pattern.id,
      patternNameSnapshot: pattern.name,
      patternArticleSnapshot: pattern.article,
    });

    // 3 операции, разные ставки.
    await createApprovedEntry(t, {
      passportId: passport.id,
      operationId: seed.operations.SEW_OVERLOCK_1.id,
      employeeId: seed.employees.seamstress.id,
      qty: 20,
      ratePerUnit: 50,
      amount: 1000,
      approvedAt: day,
    });
    await createApprovedEntry(t, {
      passportId: passport.id,
      operationId: seed.operations.SEW_OVERLOCK_2.id,
      employeeId: seed.employees.seamstress.id,
      qty: 20,
      ratePerUnit: 40,
      amount: 800,
      approvedAt: day,
    });
    await createApprovedEntry(t, {
      passportId: passport.id,
      operationId: seed.operations.CUT_CUT.id,
      employeeId: seed.employees.cutter.id,
      qty: 20,
      ratePerUnit: 10,
      amount: 200,
      approvedAt: day,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .query({ dateFrom: '2026-04-10', dateTo: '2026-04-10' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body as ProductionCostReportLike;

    // operationLines: каждая = одна OperationEntry, с nomenclatureName.
    expect(body.operationLines).toHaveLength(3);
    for (const line of body.operationLines) {
      expect(line.nomenclatureName).toBe('Худи база');
      expect(line.nomenclatureArticle).toBe('HD-001');
      expect(typeof line.ratePerUnit).toBe('string');
      expect(typeof line.amount).toBe('string');
      // unitCost = amount / qty.
      expect(Number(line.unitCost)).toBeCloseTo(
        Number(line.amount) / line.qty,
        2,
      );
      // passportNumber может быть, но не должен быть обязательным —
      // тип `?:`. Проверим, что DTO валиден без него.
      expect(line).toHaveProperty('orderId');
    }

    expect(body.nomenclatureGroups).toHaveLength(1);
    const group = body.nomenclatureGroups[0]!;
    expect(group.nomenclatureName).toBe('Худи база');
    expect(group.patternItemId).toBe(pattern.id);
    // releasedQty = qtyGood = 20, а НЕ count(passport) = 1 и НЕ
    // sum(OperationEntry.qty) = 60.
    expect(group.releasedQty).toBe(20);
    expect(group.passportsCount).toBe(1);
    expect(group.ordersCount).toBe(1);
    // operationPieceworkCostRub = 1000 + 800 + 200 = 2000.
    expect(Number(group.operationPieceworkCostRub)).toBeCloseTo(2000, 2);
    expect(Number(group.totalCostRub)).toBeCloseTo(2000, 2);
    // unitCost = 2000 / 20 = 100.
    expect(Number(group.unitCostRub)).toBeCloseTo(100, 2);

    // Breakdown: 3 операции, 2 сотрудника.
    expect(group.operationBreakdown).toHaveLength(3);
    expect(group.employeeBreakdown).toHaveLength(2);

    // Order group consistent.
    expect(body.orderGroups).toHaveLength(1);
    expect(body.orderGroups[0]!.releasedQty).toBe(20);
  });

  // -------------------------------------------------------------------------
  // 2. Два паспорта под одно лекало → суммируется в одну группу
  // -------------------------------------------------------------------------

  test('2. Два паспорта под одно лекало → одна nomenclature group, releasedQty = 40', async () => {
    const day = utcDay('2026-04-11');
    const pattern = await t.prisma.patternItem.create({
      data: { name: 'Футболка база', article: 'TS-001', status: 'ACTIVE' },
    });

    // Один и тот же заказ, два паспорта.
    const order = await t.prisma.order.create({
      data: {
        number: `O-PCV2-${rand()}`,
        orderDate: day,
        status: 'IN_PRODUCTION',
        patternItemId: pattern.id,
        patternNameSnapshot: pattern.name,
        patternArticleSnapshot: pattern.article,
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M,
            qtyPlan: 40,
          },
        },
      },
    });
    const p1 = await createPackedPassportInOrder(t, seed, order.id, {
      qtyPlan: 20,
      qtyGood: 20,
      cutDate: day,
    });
    const p2 = await createPackedPassportInOrder(t, seed, order.id, {
      qtyPlan: 20,
      qtyGood: 20,
      cutDate: day,
    });
    await createApprovedEntry(t, {
      passportId: p1.id,
      operationId: seed.operations.SEW_OVERLOCK_1.id,
      employeeId: seed.employees.seamstress.id,
      qty: 20,
      ratePerUnit: 10,
      amount: 200,
      approvedAt: day,
    });
    await createApprovedEntry(t, {
      passportId: p2.id,
      operationId: seed.operations.SEW_OVERLOCK_1.id,
      employeeId: seed.employees.seamstress.id,
      qty: 20,
      ratePerUnit: 10,
      amount: 200,
      approvedAt: day,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .query({ dateFrom: '2026-04-11', dateTo: '2026-04-11' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body as ProductionCostReportLike;
    expect(body.nomenclatureGroups).toHaveLength(1);
    const g = body.nomenclatureGroups[0]!;
    expect(g.releasedQty).toBe(40);
    expect(g.passportsCount).toBe(2);
    expect(g.ordersCount).toBe(1);
    expect(Number(g.operationPieceworkCostRub)).toBeCloseTo(400, 2);
  });

  // -------------------------------------------------------------------------
  // 3. Разные паттерны → разные группы
  // -------------------------------------------------------------------------

  test('3. Два разных лекала → две группы', async () => {
    const day = utcDay('2026-04-12');
    const p1 = await t.prisma.patternItem.create({
      data: { name: 'Лекало A', article: 'A-001', status: 'ACTIVE' },
    });
    const p2 = await t.prisma.patternItem.create({
      data: { name: 'Лекало B', article: 'B-001', status: 'ACTIVE' },
    });
    const passA = await createPackedPassport(t, seed, {
      qtyPlan: 5,
      qtyGood: 5,
      cutDate: day,
      patternItemId: p1.id,
      patternNameSnapshot: p1.name,
      patternArticleSnapshot: p1.article,
    });
    const passB = await createPackedPassport(t, seed, {
      qtyPlan: 7,
      qtyGood: 7,
      cutDate: day,
      patternItemId: p2.id,
      patternNameSnapshot: p2.name,
      patternArticleSnapshot: p2.article,
    });
    await createApprovedEntry(t, {
      passportId: passA.id,
      operationId: seed.operations.SEW_OVERLOCK_1.id,
      employeeId: seed.employees.seamstress.id,
      qty: 5,
      ratePerUnit: 10,
      amount: 50,
      approvedAt: day,
    });
    await createApprovedEntry(t, {
      passportId: passB.id,
      operationId: seed.operations.SEW_OVERLOCK_1.id,
      employeeId: seed.employees.seamstress.id,
      qty: 7,
      ratePerUnit: 10,
      amount: 70,
      approvedAt: day,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .query({ dateFrom: '2026-04-12', dateTo: '2026-04-12' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body as ProductionCostReportLike;
    expect(body.nomenclatureGroups).toHaveLength(2);
    const totalReleased = body.nomenclatureGroups.reduce(
      (sum, g) => sum + g.releasedQty,
      0,
    );
    expect(totalReleased).toBe(12);
  });

  // -------------------------------------------------------------------------
  // 4. OrderCostEstimate с MATERIAL → materialCostRub учтён
  // -------------------------------------------------------------------------

  test('4. Заказ с completed cost estimate → material/hardware/application учтены пропорционально выпуску', async () => {
    const day = utcDay('2026-04-13');
    const pattern = await t.prisma.patternItem.create({
      data: { name: 'Лекало C', article: 'C-001', status: 'ACTIVE' },
    });
    const order = await t.prisma.order.create({
      data: {
        number: `O-PCV2-${rand()}`,
        orderDate: day,
        status: 'IN_PRODUCTION',
        patternItemId: pattern.id,
        patternNameSnapshot: pattern.name,
        patternArticleSnapshot: pattern.article,
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M,
            qtyPlan: 10,
          },
        },
      },
    });
    // Cost estimate: MATERIAL 600 ₽, HARDWARE 200 ₽, APPLICATION 100 ₽.
    await t.prisma.orderCostEstimate.create({
      data: {
        orderId: order.id,
        version: 1,
        status: 'COMPLETED',
        totalCostRub: new Prisma.Decimal(900),
        completedAt: day,
        lines: {
          create: [
            estimateLine('MATERIAL', 600),
            estimateLine('HARDWARE', 200),
            estimateLine('APPLICATION', 100),
          ],
        },
      },
    });

    // Выпускаем половину (5 из 10). Проративка: 0.5 → MATERIAL 300,
    // HARDWARE 100, APPLICATION 50.
    const passport = await createPackedPassportInOrder(t, seed, order.id, {
      qtyPlan: 5,
      qtyGood: 5,
      cutDate: day,
    });
    await createApprovedEntry(t, {
      passportId: passport.id,
      operationId: seed.operations.SEW_OVERLOCK_1.id,
      employeeId: seed.employees.seamstress.id,
      qty: 5,
      ratePerUnit: 10,
      amount: 50,
      approvedAt: day,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .query({ dateFrom: '2026-04-13', dateTo: '2026-04-13' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body as ProductionCostReportLike;
    expect(body.orderGroups).toHaveLength(1);
    const og = body.orderGroups[0]!;
    expect(og.materialSource).toBe('COST_ESTIMATE');
    expect(Number(og.materialCostRub)).toBeCloseTo(300, 2);
    expect(Number(og.hardwareCostRub)).toBeCloseTo(100, 2);
    expect(Number(og.applicationCostRub)).toBeCloseTo(50, 2);
    // Operations 50 + materials 450 = 500.
    expect(Number(og.totalCostRub)).toBeCloseTo(500, 2);
    // releasedQty = 5 → unitCost = 100.
    expect(Number(og.unitCostRub)).toBeCloseTo(100, 2);
  });

  // -------------------------------------------------------------------------
  // 5. customerUnitPrice (RUB) × releasedQty → revenue + margin
  // -------------------------------------------------------------------------

  test('5. customerUnitPrice (RUB) даёт корректную revenue и margin', async () => {
    const day = utcDay('2026-04-14');
    const pattern = await t.prisma.patternItem.create({
      data: { name: 'Лекало D', article: 'D-001', status: 'ACTIVE' },
    });
    const order = await t.prisma.order.create({
      data: {
        number: `O-PCV2-${rand()}`,
        orderDate: day,
        status: 'IN_PRODUCTION',
        patternItemId: pattern.id,
        patternNameSnapshot: pattern.name,
        patternArticleSnapshot: pattern.article,
        customerUnitPrice: new Prisma.Decimal(500),
        customerCurrency: 'RUB',
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M,
            qtyPlan: 10,
          },
        },
      },
    });
    const passport = await createPackedPassportInOrder(t, seed, order.id, {
      qtyPlan: 10,
      qtyGood: 10,
      cutDate: day,
    });
    await createApprovedEntry(t, {
      passportId: passport.id,
      operationId: seed.operations.SEW_OVERLOCK_1.id,
      employeeId: seed.employees.seamstress.id,
      qty: 10,
      ratePerUnit: 50,
      amount: 500,
      approvedAt: day,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .query({ dateFrom: '2026-04-14', dateTo: '2026-04-14' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body as ProductionCostReportLike;
    const og = body.orderGroups[0]!;
    // Revenue = 500 × 10 = 5000.
    expect(Number(og.revenueRub)).toBeCloseTo(5000, 2);
    // Cost = 500 (operations) + 0 (no materials).
    expect(Number(og.totalCostRub)).toBeCloseTo(500, 2);
    expect(Number(og.marginRub)).toBeCloseTo(4500, 2);
    expect(Number(og.marginPercent)).toBeCloseTo(90, 1);
  });

  // -------------------------------------------------------------------------
  // 6. RBAC
  // -------------------------------------------------------------------------

  test('6a. ADMIN / SHOP_MANAGER → 200', async () => {
    const r1 = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .set('Cookie', cookies.admin);
    expect(r1.status).toBe(200);
    const r2 = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .set('Cookie', cookies.manager);
    expect(r2.status).toBe(200);
  });

  test('6b. SEAMSTRESS / QC / PACKING → 403', async () => {
    for (const role of ['seamstress', 'qc', 'packer'] as const) {
      const r = await request(t.app.getHttpServer())
        .get('/api/admin/production-cost/v2')
        .set('Cookie', cookies[role]);
      expect(r.status).toBe(403);
    }
  });

  test('6c. Без сессии → 401', async () => {
    const r = await request(t.app.getHttpServer()).get(
      '/api/admin/production-cost/v2',
    );
    expect(r.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // 7. Заказ без cost estimate и без workshop need → materialSource = NONE
  // -------------------------------------------------------------------------

  test('7. Заказ без расчёта и без потребности → materialSource = NONE + warning', async () => {
    const day = utcDay('2026-04-15');
    const pattern = await t.prisma.patternItem.create({
      data: { name: 'Лекало E', article: 'E-001', status: 'ACTIVE' },
    });
    const passport = await createPackedPassport(t, seed, {
      qtyPlan: 3,
      qtyGood: 3,
      cutDate: day,
      patternItemId: pattern.id,
      patternNameSnapshot: pattern.name,
      patternArticleSnapshot: pattern.article,
    });
    await createApprovedEntry(t, {
      passportId: passport.id,
      operationId: seed.operations.SEW_OVERLOCK_1.id,
      employeeId: seed.employees.seamstress.id,
      qty: 3,
      ratePerUnit: 10,
      amount: 30,
      approvedAt: day,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .query({ dateFrom: '2026-04-15', dateTo: '2026-04-15' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body as ProductionCostReportLike;
    const og = body.orderGroups[0]!;
    expect(og.materialSource).toBe('NONE');
    expect(Number(og.materialCostRub)).toBe(0);
    expect(body.warnings.some((w) => /нет источника материалов/i.test(w)))
      .toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. Паспорт — не основной разрез: passportId/passportNumber optional
  // -------------------------------------------------------------------------

  test('8. operationLines содержат nomenclatureName, passportNumber — optional technical', async () => {
    const day = utcDay('2026-04-16');
    const pattern = await t.prisma.patternItem.create({
      data: { name: 'Лекало F', article: 'F-001', status: 'ACTIVE' },
    });
    const passport = await createPackedPassport(t, seed, {
      qtyPlan: 2,
      qtyGood: 2,
      cutDate: day,
      patternItemId: pattern.id,
      patternNameSnapshot: pattern.name,
      patternArticleSnapshot: pattern.article,
    });
    await createApprovedEntry(t, {
      passportId: passport.id,
      operationId: seed.operations.SEW_OVERLOCK_1.id,
      employeeId: seed.employees.seamstress.id,
      qty: 2,
      ratePerUnit: 10,
      amount: 20,
      approvedAt: day,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .query({ dateFrom: '2026-04-16', dateTo: '2026-04-16' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body as ProductionCostReportLike;
    const line = body.operationLines[0]!;
    // Главные поля управленческого отчёта.
    expect(line.nomenclatureName).toBe('Лекало F');
    expect(line.orderNumber).toBeTruthy();
    expect(line.operationName).toBeTruthy();
    expect(line.employeeName).toBeTruthy();
    expect(line.qty).toBe(2);
    // passportId/passportNumber могут присутствовать как technical
    // поля, но они НЕ обязательные. JSON может содержать их или нет —
    // мы не должны на них полагаться в основной таблице.
    if ('passportNumber' in line) {
      expect(typeof line.passportNumber).toBe('string');
    }
  });

  test('окладные операции (ОТК) попадают в salaryOperationBreakdown, но не в сдельную таблицу', async () => {
    const day = utcDay('2026-04-22');
    // ОТК-сотрудник на оклад: 4800/смена → 10 ₽/мин.
    await t.prisma.employee.update({
      where: { id: seed.employees.qc.id },
      data: {
        compensationType: 'SALARY',
        // `salaryPerShift` — LEGACY-колонка (см. schema): с переходом
        // окладного контура на почасовую оплату в расчёте не участвует,
        // миграция один раз залила `salaryPerHour = salaryPerShift / 8`.
        // 4800 ₽/смена = 600 ₽/час = 10 ₽/мин.
        salaryPerHour: new Prisma.Decimal(600),
      },
    });
    const passport = await createPackedPassport(t, seed, {
      qtyPlan: 5,
      qtyGood: 5,
      cutDate: day,
    });
    // ОТК держал паспорт 6 минут (ISSUED→FINISHED, operationId = QC).
    await t.prisma.passportEvent.createMany({
      data: [
        {
          passportId: passport.id,
          type: 'ISSUED_TO_EMPLOYEE',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: new Date('2026-04-22T08:00:00.000Z'),
        },
        {
          passportId: passport.id,
          type: 'OPERATION_FINISHED',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: new Date('2026-04-22T08:06:00.000Z'),
        },
      ],
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .query({ dateFrom: '2026-04-22', dateTo: '2026-04-22' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body as ProductionCostReportLike;

    const qc = body.salaryOperationBreakdown.find(
      (r) => r.operationName === 'ОТК',
    );
    expect(qc).toBeDefined();
    expect(qc!.minutes).toBeCloseTo(6, 1);
    expect(Number(qc!.rub)).toBeCloseTo(60, 2); // 6 мин × 10 ₽/мин
    // В сдельной таблице ОТК нет (SALARY_ONLY → нет OperationEntry).
    expect(
      body.operationLines.some((l) => l.operationName === 'ОТК'),
    ).toBe(false);

    // Рабочая (разнесённая) окладная часть = 6 мин × 10 ₽ = 60 ₽.
    expect(Number(body.totals.salaryWorkingCostRub)).toBeCloseTo(60, 2);
    expect(body.totals.salaryWorkingMinutes).toBeCloseTo(6, 1);
    // Без `SalaryEntry` (никто не отмечен «на смене») простоя нет.
    expect(Number(body.totals.idleSalaryCostRub)).toBeCloseTo(0, 2);
    expect(body.totals.idleSalaryMinutes).toBeCloseTo(0, 1);
  });

  test('простой по окладной части: 480 − разнесённое время × ставка', async () => {
    const day = utcDay('2026-04-23');
    // ОТК-сотрудник на оклад: 4800/смена → 10 ₽/мин.
    await t.prisma.employee.update({
      where: { id: seed.employees.qc.id },
      data: {
        compensationType: 'SALARY',
        // `salaryPerShift` — LEGACY-колонка (см. schema): с переходом
        // окладного контура на почасовую оплату в расчёте не участвует,
        // миграция один раз залила `salaryPerHour = salaryPerShift / 8`.
        // 4800 ₽/смена = 600 ₽/час = 10 ₽/мин.
        salaryPerHour: new Prisma.Decimal(600),
      },
    });
    // Был на смене в этот день (источник простоя — `SalaryEntry`).
    await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: day,
        amount: new Prisma.Decimal(4800),
      },
    });
    const passport = await createPackedPassport(t, seed, {
      qtyPlan: 5,
      qtyGood: 5,
      cutDate: day,
    });
    // ОТК держал паспорт 6 минут → разнесено 6 мин, простой = 474 мин.
    await t.prisma.passportEvent.createMany({
      data: [
        {
          passportId: passport.id,
          type: 'ISSUED_TO_EMPLOYEE',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: new Date('2026-04-23T08:00:00.000Z'),
        },
        {
          passportId: passport.id,
          type: 'OPERATION_FINISHED',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: new Date('2026-04-23T08:06:00.000Z'),
        },
      ],
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .query({ dateFrom: '2026-04-23', dateTo: '2026-04-23' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body as ProductionCostReportLike;

    // Рабочая часть = 6 мин × 10 ₽ = 60 ₽.
    expect(Number(body.totals.salaryWorkingCostRub)).toBeCloseTo(60, 2);
    expect(body.totals.salaryWorkingMinutes).toBeCloseTo(6, 1);
    // Простой = (480 − 6) мин × 10 ₽ = 4740 ₽.
    expect(body.totals.idleSalaryMinutes).toBeCloseTo(474, 1);
    expect(Number(body.totals.idleSalaryCostRub)).toBeCloseTo(4740, 2);
  });

  test('месячный оклад: простой считается по норме часов, а не проваливается в ноль', async () => {
    const day = utcDay('2026-04-23');
    // Месячник: часовой ставки у него НЕТ и быть не должно — ₽/час
    // выводится из оклада и нормы часов месяца.
    await t.prisma.employee.update({
      where: { id: seed.employees.qc.id },
      data: {
        compensationType: 'SALARY',
        salaryRateMode: 'MONTHLY',
        salaryPerMonth: new Prisma.Decimal(96000),
        salaryPerHour: null,
      },
    });
    // Норма апреля — 160 ч → 96000 / 160 = 600 ₽/час = 10 ₽/мин.
    await t.prisma.payrollCalendarMonth.upsert({
      where: {
        PayrollCalendarMonth_year_month_uniq: { year: 2026, month: 4 },
      },
      create: {
        year: 2026,
        month: 4,
        normDays: 20,
        normHours: new Prisma.Decimal(160),
      },
      update: { normHours: new Prisma.Decimal(160) },
    });
    await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: day,
        amount: new Prisma.Decimal(96000),
      },
    });
    const passport = await createPackedPassport(t, seed, {
      qtyPlan: 5,
      qtyGood: 5,
      cutDate: day,
    });
    await t.prisma.passportEvent.createMany({
      data: [
        {
          passportId: passport.id,
          type: 'ISSUED_TO_EMPLOYEE',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: new Date('2026-04-23T08:00:00.000Z'),
        },
        {
          passportId: passport.id,
          type: 'OPERATION_FINISHED',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: new Date('2026-04-23T08:06:00.000Z'),
        },
      ],
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/admin/production-cost/v2')
      .query({ dateFrom: '2026-04-23', dateTo: '2026-04-23' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body as ProductionCostReportLike;

    // До фикса простой брал ставку напрямую из `salaryPerHour`, у
    // месячника пустого, — и весь его простой проваливался в ноль, хотя
    // рабочая часть по нему считалась через норму часов. Отчёт
    // противоречил сам себе.
    expect(Number(body.totals.salaryWorkingCostRub)).toBeCloseTo(60, 2);
    expect(body.totals.idleSalaryMinutes).toBeCloseTo(474, 1);
    expect(Number(body.totals.idleSalaryCostRub)).toBeCloseTo(4740, 2);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ProductionCostReportLike {
  totals: {
    releasedQty: number;
    operationPieceworkCostRub: string;
    totalCostRub: string;
    marginRub: string;
    salaryWorkingCostRub: string;
    salaryWorkingMinutes: number;
    idleSalaryCostRub: string;
    idleSalaryMinutes: number;
  };
  nomenclatureGroups: Array<{
    nomenclatureKey: string;
    nomenclatureName: string | null;
    nomenclatureArticle: string | null;
    patternItemId: string | null;
    releasedQty: number;
    passportsCount: number;
    ordersCount: number;
    operationPieceworkCostRub: string;
    totalCostRub: string;
    unitCostRub: string | null;
    operationBreakdown: Array<{ operationId: string }>;
    employeeBreakdown: Array<{ employeeId: string }>;
    sizeBreakdown: Array<{ sizeCode: string; releasedQty: number }>;
  }>;
  orderGroups: Array<{
    orderId: string;
    releasedQty: number;
    revenueRub: string;
    materialCostRub: string;
    hardwareCostRub: string;
    applicationCostRub: string;
    operationPieceworkCostRub: string;
    totalCostRub: string;
    unitCostRub: string | null;
    marginRub: string;
    marginPercent: string | null;
    materialSource: string;
  }>;
  operationLines: Array<{
    operationEntryId: string;
    orderId: string;
    orderNumber: string;
    nomenclatureName: string | null;
    nomenclatureArticle: string | null;
    operationName: string;
    employeeName: string;
    qty: number;
    ratePerUnit: string;
    amount: string;
    unitCost: string | null;
    passportId?: string;
    passportNumber?: string;
  }>;
  salaryOperationBreakdown: Array<{
    operationId: string;
    operationName: string;
    operationCategory: string;
    minutes: number;
    rub: string;
    rubPerMinute: string | null;
  }>;
  warnings: string[];
}

function utcDay(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function createPackedPassport(
  t: TestApp,
  seed: SeedResult,
  opts: {
    qtyPlan: number;
    qtyGood: number;
    cutDate: Date;
    patternItemId?: string | null;
    patternNameSnapshot?: string | null;
    patternArticleSnapshot?: string | null;
  },
): Promise<{ id: string }> {
  const order = await t.prisma.order.create({
    data: {
      number: `O-PCV2-${rand()}`,
      orderDate: opts.cutDate,
      status: 'IN_PRODUCTION',
      patternItemId: opts.patternItemId ?? null,
      patternNameSnapshot: opts.patternNameSnapshot ?? null,
      patternArticleSnapshot: opts.patternArticleSnapshot ?? null,
      items: {
        create: {
          productId: seed.product.id,
          sizeId: seed.sizes.M,
          qtyPlan: opts.qtyPlan,
        },
      },
    },
  });
  return createPackedPassportInOrder(t, seed, order.id, {
    qtyPlan: opts.qtyPlan,
    qtyGood: opts.qtyGood,
    cutDate: opts.cutDate,
  });
}

async function createPackedPassportInOrder(
  t: TestApp,
  seed: SeedResult,
  orderId: string,
  opts: { qtyPlan: number; qtyGood: number; cutDate: Date },
): Promise<{ id: string }> {
  const p = await t.prisma.passport.create({
    data: {
      number: `P-PCV2-${rand()}`,
      orderId,
      productId: seed.product.id,
      sizeId: seed.sizes.M,
      color: seed.product.color,
      rollNumber: 'R-PCV2',
      cutDate: opts.cutDate,
      qtyPlan: opts.qtyPlan,
      qtyCut: opts.qtyPlan,
      qtyGood: opts.qtyGood,
      qrCode: `passport:pcv2-${rand()}`,
      cutterId: seed.employees.cutter.id,
      creatorId: seed.employees.cutter.id,
      status: 'PACKED',
    },
  });
  // PACKED-event для детекта периода.
  await t.prisma.passportEvent.create({
    data: {
      passportId: p.id,
      type: 'PACKED',
      employeeId: seed.employees.packer.id,
      qty: opts.qtyGood,
      createdAt: opts.cutDate,
    },
  });
  return { id: p.id };
}

async function createApprovedEntry(
  t: TestApp,
  args: {
    passportId: string;
    operationId: string;
    employeeId: string;
    qty: number;
    ratePerUnit: number;
    amount: number;
    approvedAt: Date;
  },
): Promise<void> {
  await t.prisma.operationEntry.create({
    data: {
      passportId: args.passportId,
      operationId: args.operationId,
      employeeId: args.employeeId,
      qty: args.qty,
      ratePerUnit: new Prisma.Decimal(args.ratePerUnit),
      amount: new Prisma.Decimal(args.amount),
      status: 'APPROVED',
      approvalMode: 'AFTER_RELEASE',
      sourceEventType: 'OPERATION_TRANSITION',
      approvedAt: args.approvedAt,
    },
  });
}

function estimateLine(
  kind: 'MATERIAL' | 'HARDWARE' | 'APPLICATION' | 'OTHER',
  totalRub: number,
): Prisma.OrderCostEstimateLineCreateWithoutEstimateInput {
  return {
    kind,
    description: `Test ${kind}`,
    unit: 'шт',
    purchaseQty: new Prisma.Decimal(1),
    quotedPrice: new Prisma.Decimal(totalRub),
    quotedCurrency: 'RUB',
    lineTotalOriginal: new Prisma.Decimal(totalRub),
    lineTotalRub: new Prisma.Decimal(totalRub),
  };
}

let _suffix = 0;
function rand(): string {
  _suffix += 1;
  return `${Date.now()}-${_suffix}`;
}
