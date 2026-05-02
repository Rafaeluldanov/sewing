/**
 * Integration-тесты B2B-схемы начисления закройщика
 * (см. `docs/payroll-cutter-compensation-recon.md`).
 *
 * Покрытие:
 *   1. Marketplace (`CompanyDivision.code = MARKETPLACE`) — старая
 *      фиксированная схема `amount = Operation(CUT_CUT).fixedRate ×
 *      passport.qtyCut` сохранена 1-в-1.
 *   2. B2B (`CompanyDivision.code = OTHER`) + два FIXED-оверлока —
 *      формула `amount = (50 + 40) × 20 × 5 / 100 = 90`.
 *   3. B2B + BY_SIZE-оверлок — берёт ставку из
 *      `OperationRateBySize` для размера паспорта.
 *   4. B2B + SALARY_ONLY-операция в маршруте — не попадает в base.
 *   5. B2B + SEWING-операция без ставки → не падает, warning,
 *      операция в base не учитывается.
 *   6. B2B без процента (ни в Employee, ни в ENV) → не создаётся
 *      OperationEntry, audit warning.
 *   7. Идемпотентность: повторный trigger не создаёт второе
 *      начисление.
 *   8. Payroll швеи не задет (`createPendingForPreviousOperation`
 *      продолжает работать как раньше).
 *
 * Для скорости и стабильности тесты вызывают `EarningsService.
 * createImmediateForCutter` напрямую через `app.get(EarningsService)`
 * и собственную `prisma.$transaction(...)` — это та же точка, что
 * `PassportsService.create` использует в проде. Полный HTTP-flow
 * `POST /api/passports` уже покрыт `production-flow.test.ts` —
 * дублировать его здесь нет смысла.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { Prisma } from '@prisma/client';
import { EarningsService } from '@sewing/api/modules/earnings/earnings.service';
import { startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — cutter B2B compensation', () => {
  let t: TestApp;
  let seed: SeedResult;
  let earnings: EarningsService;

  beforeAll(async () => {
    t = await startTestApp();
    earnings = t.app.get(EarningsService);
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    // Не переопределяем глобальный ENV: каждый тест, которому он
    // нужен, ставит/удаляет `process.env.CUTTER_B2B_SEWING_PERCENT`
    // явно. Так не возникает порядкозависимости.
    delete process.env.CUTTER_B2B_SEWING_PERCENT;
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Создаёт заказ + единственный паспорт под него, фиксируя snapshot
   * маршрута через `routeSteps.create`. Возвращает id паспорта,
   * чтобы тесты могли сразу дёрнуть `createImmediateForCutter`.
   */
  async function setupOrderWithPassport(args: {
    divisionCode: 'MARKETPLACE' | 'OTHER';
    sizeKey: keyof SeedResult['sizes'];
    qtyPlan: number;
    qtyCut: number;
    routeSteps: Array<{ operationCode: keyof SeedResult['operations'] }>;
  }): Promise<{
    orderId: string;
    passportId: string;
    sizeId: string;
  }> {
    const sizeId = seed.sizes[args.sizeKey as string];
    const order = await t.prisma.order.create({
      data: {
        number: `O-CUT-B2B-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions[args.divisionCode].id,
        items: {
          create: { productId: seed.product.id, sizeId, qtyPlan: args.qtyPlan },
        },
        routeSteps: {
          create: args.routeSteps.map((s, i) => ({
            index: i,
            operationId: seed.operations[s.operationCode as string].id,
          })),
        },
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-CUT-B2B-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:cut-b2b-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId,
        color: seed.product.color,
        rollNumber: 'R-1',
        cutDate: new Date(),
        qtyPlan: args.qtyPlan,
        qtyCut: args.qtyCut,
        qtyGood: args.qtyCut,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
    return { orderId: order.id, passportId: passport.id, sizeId };
  }

  /**
   * Помощник: запускает `EarningsService.createImmediateForCutter`
   * в реальной транзакции — точно так же, как `PassportsService.
   * create`. Возвращает массив `OperationEntry` для паспорта.
   */
  async function triggerCutter(args: {
    passportId: string;
    sizeId: string;
    qty: number;
  }): Promise<
    Array<{
      employeeId: string;
      operationId: string;
      qty: number;
      amount: string;
      ratePerUnit: string;
      sourceEventType: string;
      status: string;
    }>
  > {
    await t.prisma.$transaction(async (tx) => {
      await earnings.createImmediateForCutter(tx, {
        passportId: args.passportId,
        cutterId: seed.employees.cutter.id,
        sizeId: args.sizeId,
        productId: seed.product.id,
        qty: args.qty,
      });
    });
    const rows = await t.prisma.operationEntry.findMany({
      where: { passportId: args.passportId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      employeeId: r.employeeId,
      operationId: r.operationId,
      qty: r.qty,
      amount: r.amount.toFixed(2),
      ratePerUnit: r.ratePerUnit.toFixed(2),
      sourceEventType: r.sourceEventType,
      status: r.status,
    }));
  }

  /**
   * Перезаписывает `Operation.fixedRate` (для FIXED-операций)
   * на нужное значение — используем для удобной настройки
   * сценариев без полного перепереиспользования seed.
   */
  async function setFixedRate(
    operationCode: keyof SeedResult['operations'],
    rate: number,
  ): Promise<void> {
    await t.prisma.operation.update({
      where: { id: seed.operations[operationCode as string].id },
      data: {
        pricingMode: 'FIXED',
        fixedRate: new Prisma.Decimal(rate),
      },
    });
  }

  /**
   * Перезаписывает категорию операции — используем, чтобы превратить
   * раскрой/QC в SEWING (для теста SALARY_ONLY-операции в SEWING-категории
   * и т.п.) без изменения seed-данных.
   */
  async function setCategory(
    operationCode: keyof SeedResult['operations'],
    category: 'CUTTING' | 'SEWING' | 'QC' | 'IRONING' | 'PACKING',
    pricingMode?: 'FIXED' | 'BY_SIZE' | 'SALARY_ONLY',
  ): Promise<void> {
    const data: { category: typeof category; pricingMode?: typeof pricingMode } = {
      category,
    };
    if (pricingMode) data.pricingMode = pricingMode;
    await t.prisma.operation.update({
      where: { id: seed.operations[operationCode as string].id },
      data,
    });
  }

  /**
   * Удаляет `OperationRateBySize` для пары (operation, size). Нужно
   * для сценария «BY_SIZE-операция без ставки → не падаем, warning».
   */
  async function clearRateBySize(
    operationCode: keyof SeedResult['operations'],
    sizeId: string,
  ): Promise<void> {
    await t.prisma.operationRateBySize.deleteMany({
      where: {
        operationId: seed.operations[operationCode as string].id,
        sizeId,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // 1. MARKETPLACE OLD FLOW
  // ---------------------------------------------------------------------------

  test('Marketplace: amount = fixedRate × qty (старая схема, B2B percent игнорируется)', async () => {
    // CUT_CUT в seed: FIXED 10₽; меняем не нужно. Маршрут не важен —
    // marketplace схема его не читает.
    const setup = await setupOrderWithPassport({
      divisionCode: 'MARKETPLACE',
      sizeKey: 'M',
      qtyPlan: 20,
      qtyCut: 20,
      routeSteps: [
        { operationCode: 'SEW_OVERLOCK_1' },
        { operationCode: 'SEW_OVERLOCK_2' },
      ],
    });
    // Даже если у сотрудника задан B2B-процент — marketplace его НЕ
    // должна использовать.
    await t.prisma.employee.update({
      where: { id: seed.employees.cutter.id },
      data: { cutterB2bSewingPercent: new Prisma.Decimal(50) },
    });

    const entries = await triggerCutter({
      passportId: setup.passportId,
      sizeId: setup.sizeId,
      qty: 20,
    });

    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.employeeId).toBe(seed.employees.cutter.id);
    expect(e.operationId).toBe(seed.operations.CUT_CUT.id);
    expect(e.sourceEventType).toBe('PASSPORT_CREATED');
    expect(e.status).toBe('APPROVED');
    expect(e.qty).toBe(20);
    // 10 × 20 = 200 (старая формула)
    expect(e.amount).toBe('200.00');
    expect(e.ratePerUnit).toBe('10.00');
  });

  // ---------------------------------------------------------------------------
  // 2. B2B WITH FIXED SEWING OPERATIONS
  // ---------------------------------------------------------------------------

  test('B2B + два FIXED-оверлока (50₽ и 40₽), qty=20, percent=5 → amount=90, ratePerUnit=4.50', async () => {
    // Перенастраиваем оба seed-оверлока в FIXED с нужными ставками.
    await setFixedRate('SEW_OVERLOCK_1', 50);
    await setFixedRate('SEW_OVERLOCK_2', 40);

    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 20,
      qtyCut: 20,
      routeSteps: [
        { operationCode: 'SEW_OVERLOCK_1' },
        { operationCode: 'SEW_OVERLOCK_2' },
      ],
    });
    await t.prisma.employee.update({
      where: { id: seed.employees.cutter.id },
      data: { cutterB2bSewingPercent: new Prisma.Decimal(5) },
    });

    const entries = await triggerCutter({
      passportId: setup.passportId,
      sizeId: setup.sizeId,
      qty: 20,
    });
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    // base = (50 + 40) × 20 = 1800
    // amount = 1800 × 5 / 100 = 90
    // ratePerUnit = 90 / 20 = 4.50
    expect(e.amount).toBe('90.00');
    expect(e.ratePerUnit).toBe('4.50');
    expect(e.qty).toBe(20);
    expect(e.sourceEventType).toBe('PASSPORT_CREATED');
    expect(e.status).toBe('APPROVED');
  });

  // ---------------------------------------------------------------------------
  // 3. B2B WITH BY_SIZE
  // ---------------------------------------------------------------------------

  test('B2B + BY_SIZE-оверлок (size M = 70), qty=10, percent=10 → base=700, amount=70', async () => {
    // Перенастраиваем оба оверлока: первый — единственный SEWING с
    // BY_SIZE, второй — выкидываем из маршрута, чтобы не мешал.
    await t.prisma.operation.update({
      where: { id: seed.operations.SEW_OVERLOCK_1.id },
      data: { pricingMode: 'BY_SIZE', fixedRate: null },
    });
    // В seed для размеров S/M/L уже есть OperationRateBySize=10 —
    // переопределяем нужную ставку.
    await t.prisma.operationRateBySize.update({
      where: {
        OperationRateBySize_operation_size_uniq: {
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          sizeId: seed.sizes.M,
        },
      },
      data: { rate: new Prisma.Decimal(70) },
    });

    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 10,
      qtyCut: 10,
      routeSteps: [{ operationCode: 'SEW_OVERLOCK_1' }],
    });
    await t.prisma.employee.update({
      where: { id: seed.employees.cutter.id },
      data: { cutterB2bSewingPercent: new Prisma.Decimal(10) },
    });

    const entries = await triggerCutter({
      passportId: setup.passportId,
      sizeId: setup.sizeId,
      qty: 10,
    });
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    // base = 70 × 10 = 700
    // amount = 700 × 10 / 100 = 70
    expect(e.amount).toBe('70.00');
    expect(e.ratePerUnit).toBe('7.00');
  });

  // ---------------------------------------------------------------------------
  // 4. B2B + SALARY_ONLY SEWING OPERATION
  // ---------------------------------------------------------------------------

  test('B2B + SEWING-операция SALARY_ONLY → не попадает в base (amount=0 → начисление не создаётся)', async () => {
    // Делаем оверлок «оклад» — он остаётся в категории SEWING, но
    // больше не должен давать base.
    await setCategory('SEW_OVERLOCK_1', 'SEWING', 'SALARY_ONLY');
    // Второй оверлок — тоже выводим из base (тестируем только SALARY_ONLY-кейс).
    await setCategory('SEW_OVERLOCK_2', 'SEWING', 'SALARY_ONLY');

    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 10,
      qtyCut: 10,
      routeSteps: [
        { operationCode: 'SEW_OVERLOCK_1' },
        { operationCode: 'SEW_OVERLOCK_2' },
      ],
    });
    await t.prisma.employee.update({
      where: { id: seed.employees.cutter.id },
      data: { cutterB2bSewingPercent: new Prisma.Decimal(50) },
    });

    const entries = await triggerCutter({
      passportId: setup.passportId,
      sizeId: setup.sizeId,
      qty: 10,
    });
    // base = 0, amount = 0 — `OperationEntry` не создаётся.
    expect(entries).toHaveLength(0);

    // В audit-логе должна быть запись CUTTER_B2B_AMOUNT_ZERO с
    // warnings.
    const audit = await t.prisma.auditLog.findFirst({
      where: {
        entityType: 'PASSPORT',
        entityId: setup.passportId,
        event: 'CUTTER_B2B_AMOUNT_ZERO',
      },
    });
    expect(audit).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 5. B2B + missing rate
  // ---------------------------------------------------------------------------

  test('B2B + SEWING BY_SIZE без ставки для размера → не падает, операция не в base', async () => {
    // Один оверлок — BY_SIZE c удалённой ставкой для нашего размера;
    // второй оверлок — FIXED 100, чтобы база не была нулевой и
    // начисление всё-таки создалось.
    await t.prisma.operation.update({
      where: { id: seed.operations.SEW_OVERLOCK_1.id },
      data: { pricingMode: 'BY_SIZE', fixedRate: null },
    });
    await clearRateBySize('SEW_OVERLOCK_1', seed.sizes.M);
    await setFixedRate('SEW_OVERLOCK_2', 100);

    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 10,
      qtyCut: 10,
      routeSteps: [
        { operationCode: 'SEW_OVERLOCK_1' },
        { operationCode: 'SEW_OVERLOCK_2' },
      ],
    });
    await t.prisma.employee.update({
      where: { id: seed.employees.cutter.id },
      data: { cutterB2bSewingPercent: new Prisma.Decimal(10) },
    });

    const entries = await triggerCutter({
      passportId: setup.passportId,
      sizeId: setup.sizeId,
      qty: 10,
    });
    // Только SEW_OVERLOCK_2 в base: 100 × 10 × 10 / 100 = 100
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amount).toBe('100.00');
    expect(entries[0]!.ratePerUnit).toBe('10.00');

    // Audit для успешного начисления должен содержать warning о
    // пропущенной BY_SIZE-операции.
    const audit = await t.prisma.auditLog.findFirst({
      where: {
        entityType: 'PASSPORT',
        entityId: setup.passportId,
        event: 'CUTTER_EARNING_CREATED',
      },
    });
    expect(audit).not.toBeNull();
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.scheme).toBe('B2B_SEWING_PERCENT');
    expect(Array.isArray(payload.warnings)).toBe(true);
    expect((payload.warnings as string[]).some((w) => w.includes('SEW_OVERLOCK_1')))
      .toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 6. B2B + no percent
  // ---------------------------------------------------------------------------

  test('B2B без процента (ни в Employee, ни в ENV) → начисление не создаётся, audit warning', async () => {
    await setFixedRate('SEW_OVERLOCK_1', 50);
    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 10,
      qtyCut: 10,
      routeSteps: [{ operationCode: 'SEW_OVERLOCK_1' }],
    });
    // Employee.cutterB2bSewingPercent остаётся `null` (из upsert seed).
    // ENV `CUTTER_B2B_SEWING_PERCENT` явно очищаем в beforeEach.

    const entries = await triggerCutter({
      passportId: setup.passportId,
      sizeId: setup.sizeId,
      qty: 10,
    });
    expect(entries).toHaveLength(0);

    const audit = await t.prisma.auditLog.findFirst({
      where: {
        entityType: 'PASSPORT',
        entityId: setup.passportId,
        event: 'CUTTER_B2B_PERCENT_MISSING',
      },
    });
    expect(audit).not.toBeNull();
  });

  test('B2B без процента у сотрудника, но с ENV fallback → начисление создаётся', async () => {
    await setFixedRate('SEW_OVERLOCK_1', 50);
    process.env.CUTTER_B2B_SEWING_PERCENT = '5';

    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 10,
      qtyCut: 10,
      routeSteps: [{ operationCode: 'SEW_OVERLOCK_1' }],
    });

    try {
      const entries = await triggerCutter({
        passportId: setup.passportId,
        sizeId: setup.sizeId,
        qty: 10,
      });
      expect(entries).toHaveLength(1);
      // base = 50 × 10 = 500; amount = 500 × 5 / 100 = 25
      expect(entries[0]!.amount).toBe('25.00');
      expect(entries[0]!.ratePerUnit).toBe('2.50');
    } finally {
      delete process.env.CUTTER_B2B_SEWING_PERCENT;
    }
  });

  // ---------------------------------------------------------------------------
  // 7. IDEMPOTENCY
  // ---------------------------------------------------------------------------

  test('Повторный trigger для одного паспорта не создаёт второе начисление (B2B)', async () => {
    await setFixedRate('SEW_OVERLOCK_1', 50);
    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 10,
      qtyCut: 10,
      routeSteps: [{ operationCode: 'SEW_OVERLOCK_1' }],
    });
    await t.prisma.employee.update({
      where: { id: seed.employees.cutter.id },
      data: { cutterB2bSewingPercent: new Prisma.Decimal(5) },
    });

    await triggerCutter({
      passportId: setup.passportId,
      sizeId: setup.sizeId,
      qty: 10,
    });
    // Дёргаем второй раз — на @@unique (passportId, operationId,
    // employeeId, sourceEventType) должен сработать P2002, который
    // safeCreate глотает.
    const entries = await triggerCutter({
      passportId: setup.passportId,
      sizeId: setup.sizeId,
      qty: 10,
    });
    expect(entries).toHaveLength(1);
  });

  test('Повторный trigger для одного паспорта не создаёт второе начисление (Marketplace)', async () => {
    const setup = await setupOrderWithPassport({
      divisionCode: 'MARKETPLACE',
      sizeKey: 'M',
      qtyPlan: 5,
      qtyCut: 5,
      routeSteps: [{ operationCode: 'SEW_OVERLOCK_1' }],
    });

    await triggerCutter({
      passportId: setup.passportId,
      sizeId: setup.sizeId,
      qty: 5,
    });
    const entries = await triggerCutter({
      passportId: setup.passportId,
      sizeId: setup.sizeId,
      qty: 5,
    });
    expect(entries).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 8. NON-CUTTER PAYROLL UNAFFECTED
  // ---------------------------------------------------------------------------

  test('Швея payroll (createPendingForPreviousOperation) не задет: создаёт PENDING_RELEASE с FIXED-ставкой', async () => {
    // Перенастраиваем оверлок на FIXED, чтобы было детерминированно
    // (BY_SIZE-ставки seed-а тоже работают, но мы фиксируем
    // конкретный сценарий).
    await setFixedRate('SEW_OVERLOCK_1', 30);
    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 4,
      qtyCut: 4,
      routeSteps: [{ operationCode: 'SEW_OVERLOCK_1' }],
    });

    // Эмулируем `PassportsService.scanOnOperation`: после CUT
    // швея сканирует свою операцию — backend создаёт PENDING для
    // ПРЕДЫДУЩЕГО исполнителя (тут для самой швеи как «следующего»
    // действия мы запускаем pending помощника по той же логике).
    // Для MVP проще проверить, что метод вообще создал именно
    // PENDING_RELEASE для seamstress, а не повторил логику cutter.
    await t.prisma.$transaction(async (tx) => {
      await earnings.createPendingForPreviousOperation(tx, {
        passportId: setup.passportId,
        previousOperationId: seed.operations.SEW_OVERLOCK_1.id,
        previousEmployeeId: seed.employees.seamstress.id,
        productId: seed.product.id,
        sizeId: setup.sizeId,
        qty: 4,
      });
    });

    const rows = await t.prisma.operationEntry.findMany({
      where: {
        passportId: setup.passportId,
        employeeId: seed.employees.seamstress.id,
      },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.status).toBe('PENDING_RELEASE');
    expect(r.approvalMode).toBe('AFTER_RELEASE');
    expect(r.sourceEventType).toBe('OPERATION_TRANSITION');
    // 30 × 4 = 120 — старая формула швеи, не задетая B2B-схемой
    // закройщика.
    expect(r.amount.toFixed(2)).toBe('120.00');
    expect(r.ratePerUnit.toFixed(2)).toBe('30.00');
  });
});
