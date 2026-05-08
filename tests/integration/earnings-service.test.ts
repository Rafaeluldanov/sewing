/**
 * Integration-тест для `EarningsService` и инварианта single-write
 * `OperationEntry` — dedicated coverage по плану
 * `docs/test-gap-plan.md §P0-4`.
 *
 * Что покрываем здесь и больше нигде:
 *   - Контракт DTO двух источников начислений: `PASSPORT_CREATED` /
 *     IMMEDIATE / APPROVED против `OPERATION_TRANSITION` /
 *     AFTER_RELEASE / PENDING_RELEASE — один паспорт, обе ветки;
 *   - `createPendingForCompletedOperation` при повторном trigger даёт
 *     одну строку (composite-key
 *     `@@unique(passportId, operationId, employeeId, sourceEventType)`,
 *     обработка P2002 в `safeCreate` — см. earnings.service.ts §1068);
 *   - параллельная гонка `Promise.all` на `createPendingForPrevious-
 *     Operation` не плодит дублей — никаких 500/uncaught Prisma errors;
 *   - `approvePendingForPassport` переводит только PENDING/PENDING_
 *     RELEASE → APPROVED, не трогает CANCELLED/REVERSED, идемпотентен
 *     при повторе (count = 0), у уже APPROVED не сдвигает `approvedAt`.
 *
 * Чего сознательно НЕ покрываем — у соседей уже есть, не дублируем:
 *   - `createImmediateForCutter` идемпотентность — в `cutter-
 *     compensation.test.ts §«Повторный trigger ... B2B / Marketplace»`;
 *   - Marketplace-/B2B-формулы и amount/ratePerUnit — там же;
 *   - cutter attribution (creator-CUTTER vs explicit `cutterId`) — в
 *     `cutter-attribution.test.ts`;
 *   - HTTP-level scan x2 idempotency — в `production-flow.test.ts §B`
 *     (line 232-251);
 *   - close-box → PENDING_RELEASE → APPROVED, close x2 → 409 без
 *     дублей — в `production-flow.test.ts §F` (line 1137-1180);
 *   - complete-operation idempotency на passport state — в
 *     `passports-complete-operation.test.ts`.
 *
 * Стиль вызова сервиса напрямую через `t.app.get(EarningsService)` +
 * `prisma.$transaction(...)` повторяет шаблон `cutter-compensation.
 * test.ts` — это та же точка, в которой `PassportsService` дёргает
 * earnings в проде.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { Prisma } from '@prisma/client';
import { EarningsService } from '@sewing/api/modules/earnings/earnings.service';
import { startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — EarningsService and OperationEntry single-write (P0-4)', () => {
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
    delete process.env.CUTTER_B2B_SEWING_PERCENT;
  });

  // ---------------------------------------------------------------------------
  // Helpers (повторяют шаблон cutter-compensation.test.ts; разные имена
  // у переменных намеренно, чтобы видно было самостоятельность теста)
  // ---------------------------------------------------------------------------

  /**
   * Создаёт заказ + один паспорт с настраиваемым snapshot маршрута.
   * `divisionCode` нужен, чтобы зафиксировать схему compenation —
   * Marketplace выбираем для деталей `createImmediateForCutter`.
   */
  async function setupOrderWithPassport(args: {
    divisionCode: 'MARKETPLACE' | 'OTHER';
    sizeKey: 'S' | 'M' | 'L';
    qtyPlan: number;
    qtyCut: number;
    routeStepCodes: Array<keyof SeedResult['operations']>;
  }): Promise<{ orderId: string; passportId: string; sizeId: string }> {
    const sizeId = seed.sizes[args.sizeKey];
    const order = await t.prisma.order.create({
      data: {
        number: `O-EARN-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions[args.divisionCode].id,
        items: {
          create: { productId: seed.product.id, sizeId, qtyPlan: args.qtyPlan },
        },
        routeSteps: {
          create: args.routeStepCodes.map((code, i) => ({
            index: i,
            operationId: seed.operations[code as string].id,
          })),
        },
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-EARN-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:earn-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId,
        color: seed.product.color,
        rollNumber: 'R-EARN',
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

  /** Считает строки `OperationEntry` для (passport, source). */
  async function countEntries(
    passportId: string,
    source?: 'PASSPORT_CREATED' | 'OPERATION_TRANSITION',
  ): Promise<number> {
    return t.prisma.operationEntry.count({
      where: { passportId, ...(source ? { sourceEventType: source } : {}) },
    });
  }

  // ---------------------------------------------------------------------------
  // 1. createImmediateForCutter — контракт DTO (single row + правильные поля)
  //    Идемпотентность для этой ветки уже в cutter-compensation.test.ts.
  // ---------------------------------------------------------------------------

  test('createImmediateForCutter: APPROVED + IMMEDIATE + PASSPORT_CREATED + approvedAt', async () => {
    const setup = await setupOrderWithPassport({
      divisionCode: 'MARKETPLACE',
      sizeKey: 'M',
      qtyPlan: 5,
      qtyCut: 5,
      routeStepCodes: ['SEW_OVERLOCK_1'],
    });

    await t.prisma.$transaction(async (tx) => {
      await earnings.createImmediateForCutter(tx, {
        passportId: setup.passportId,
        cutterId: seed.employees.cutter.id,
        sizeId: setup.sizeId,
        productId: seed.product.id,
        qty: 5,
      });
    });

    const rows = await t.prisma.operationEntry.findMany({
      where: { passportId: setup.passportId },
    });
    expect(rows).toHaveLength(1);
    const e = rows[0]!;
    expect(e.employeeId).toBe(seed.employees.cutter.id);
    expect(e.status).toBe('APPROVED');
    expect(e.approvalMode).toBe('IMMEDIATE');
    expect(e.sourceEventType).toBe('PASSPORT_CREATED');
    expect(e.approvedAt).not.toBeNull();
    // Маршрутка не должна влиять на raskroy: операция всегда CUT_CUT.
    expect(e.operationId).toBe(seed.operations.CUT_CUT.id);
  });

  // ---------------------------------------------------------------------------
  // 2. createPendingForCompletedOperation — контракт DTO
  // ---------------------------------------------------------------------------

  test('createPendingForCompletedOperation: PENDING_RELEASE + AFTER_RELEASE + OPERATION_TRANSITION + approvedAt=null', async () => {
    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 4,
      qtyCut: 4,
      routeStepCodes: ['SEW_OVERLOCK_1'],
    });
    // Ставка для оверлока seed-минимум = 10₽ (BY_SIZE для M).
    await t.prisma.$transaction(async (tx) => {
      await earnings.createPendingForCompletedOperation(tx, {
        passportId: setup.passportId,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        productId: seed.product.id,
        sizeId: setup.sizeId,
        qty: 4,
        sourceEventId: null,
      });
    });

    const rows = await t.prisma.operationEntry.findMany({
      where: { passportId: setup.passportId },
    });
    expect(rows).toHaveLength(1);
    const e = rows[0]!;
    expect(e.employeeId).toBe(seed.employees.seamstress.id);
    expect(e.operationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(e.status).toBe('PENDING_RELEASE');
    expect(e.approvalMode).toBe('AFTER_RELEASE');
    expect(e.sourceEventType).toBe('OPERATION_TRANSITION');
    expect(e.approvedAt).toBeNull();
    expect(e.qty).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // 3. createPendingForCompletedOperation — повторный trigger даёт 1 строку
  //    (composite-key идемпотентность; safeCreate глотает P2002).
  // ---------------------------------------------------------------------------

  test('createPendingForCompletedOperation повторный trigger → ровно одна OperationEntry', async () => {
    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 3,
      qtyCut: 3,
      routeStepCodes: ['SEW_OVERLOCK_1'],
    });
    const trigger = () =>
      t.prisma.$transaction(async (tx) => {
        await earnings.createPendingForCompletedOperation(tx, {
          passportId: setup.passportId,
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          employeeId: seed.employees.seamstress.id,
          productId: seed.product.id,
          sizeId: setup.sizeId,
          qty: 3,
          sourceEventId: null,
        });
      });

    await trigger();
    await trigger();
    await trigger();

    expect(await countEntries(setup.passportId, 'OPERATION_TRANSITION')).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 4. RACE — параллельные триггеры createPendingForCompletedOperation
  //    не плодят дублей и не валят процесс. Composite-key + safeCreate
  //    обеспечивают одну строку в БД.
  // ---------------------------------------------------------------------------

  test('RACE: 5 параллельных createPendingForCompletedOperation → 1 строка, без 500', async () => {
    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 6,
      qtyCut: 6,
      routeStepCodes: ['SEW_OVERLOCK_1'],
    });
    const fire = () =>
      t.prisma.$transaction(async (tx) => {
        await earnings.createPendingForCompletedOperation(tx, {
          passportId: setup.passportId,
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          employeeId: seed.employees.seamstress.id,
          productId: seed.product.id,
          sizeId: setup.sizeId,
          qty: 6,
          sourceEventId: null,
        });
      });

    const results = await Promise.allSettled([fire(), fire(), fire(), fire(), fire()]);
    // Все 5 транзакций должны fulfilled — safeCreate глотает P2002.
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }
    expect(await countEntries(setup.passportId, 'OPERATION_TRANSITION')).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 5. approvePendingForPassport — позитив: PENDING/PENDING_RELEASE
  //    становятся APPROVED с approvedAt; возвращает correct count.
  // ---------------------------------------------------------------------------

  test('approvePendingForPassport: переводит pending в APPROVED и возвращает count', async () => {
    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 2,
      qtyCut: 2,
      routeStepCodes: ['SEW_OVERLOCK_1'],
    });
    // Один PENDING_RELEASE (швейный), один PENDING (теоретический —
    // у текущего flow не используется, но enum существует, и approve
    // должен ловить оба статуса).
    await t.prisma.operationEntry.create({
      data: {
        passportId: setup.passportId,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 2,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(20),
        status: 'PENDING_RELEASE',
        approvalMode: 'AFTER_RELEASE',
        sourceEventType: 'OPERATION_TRANSITION',
      },
    });
    await t.prisma.operationEntry.create({
      data: {
        passportId: setup.passportId,
        operationId: seed.operations.SEW_OVERLOCK_2.id,
        employeeId: seed.employees.seamstress.id,
        qty: 2,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(20),
        status: 'PENDING',
        approvalMode: 'AFTER_RELEASE',
        sourceEventType: 'OPERATION_TRANSITION',
      },
    });

    const approvedCount = await t.prisma.$transaction(
      async (tx) => earnings.approvePendingForPassport(tx, setup.passportId),
    );
    expect(approvedCount).toBe(2);

    const rows = await t.prisma.operationEntry.findMany({
      where: { passportId: setup.passportId },
    });
    expect(rows.every((r) => r.status === 'APPROVED')).toBe(true);
    expect(rows.every((r) => r.approvedAt !== null)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 6. approvePendingForPassport — идемпотентность: второй вызов
  //    возвращает 0 (нет pending), строки не дублируются и
  //    `approvedAt` у уже APPROVED не сдвигается.
  // ---------------------------------------------------------------------------

  test('approvePendingForPassport идемпотентен: второй вызов count=0, approvedAt стабилен', async () => {
    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 1,
      qtyCut: 1,
      routeStepCodes: ['SEW_OVERLOCK_1'],
    });
    await t.prisma.operationEntry.create({
      data: {
        passportId: setup.passportId,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 1,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(10),
        status: 'PENDING_RELEASE',
        approvalMode: 'AFTER_RELEASE',
        sourceEventType: 'OPERATION_TRANSITION',
      },
    });

    const first = await t.prisma.$transaction(
      async (tx) => earnings.approvePendingForPassport(tx, setup.passportId),
    );
    expect(first).toBe(1);

    const approvedAt1 = (await t.prisma.operationEntry.findFirstOrThrow({
      where: { passportId: setup.passportId },
    })).approvedAt;
    expect(approvedAt1).not.toBeNull();

    // 5 ms задержки — чтобы у второго `new Date()` точно был
    // наблюдаемо другой timestamp; если бы updateMany попадал по
    // фильтру, мы бы это поймали через сдвинутый approvedAt.
    await new Promise((r) => setTimeout(r, 5));

    const second = await t.prisma.$transaction(
      async (tx) => earnings.approvePendingForPassport(tx, setup.passportId),
    );
    expect(second).toBe(0);

    const after = await t.prisma.operationEntry.findFirstOrThrow({
      where: { passportId: setup.passportId },
    });
    expect(after.status).toBe('APPROVED');
    expect(after.approvedAt?.toISOString()).toBe(approvedAt1!.toISOString());
    // Записей по-прежнему одна.
    expect(await countEntries(setup.passportId)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 7. approvePendingForPassport не трогает CANCELLED/REVERSED/APPROVED
  // ---------------------------------------------------------------------------

  test('approvePendingForPassport: CANCELLED и REVERSED остаются как были', async () => {
    const setup = await setupOrderWithPassport({
      divisionCode: 'OTHER',
      sizeKey: 'M',
      qtyPlan: 3,
      qtyCut: 3,
      routeStepCodes: ['SEW_OVERLOCK_1'],
    });
    // Заполнили четырьмя строками с разными статусами и operationId,
    // чтобы не нарушить composite-key идемпотентности.
    await t.prisma.operationEntry.createMany({
      data: [
        {
          passportId: setup.passportId,
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          employeeId: seed.employees.seamstress.id,
          qty: 3,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(30),
          status: 'PENDING_RELEASE',
          approvalMode: 'AFTER_RELEASE',
          sourceEventType: 'OPERATION_TRANSITION',
        },
        {
          passportId: setup.passportId,
          operationId: seed.operations.SEW_OVERLOCK_2.id,
          employeeId: seed.employees.seamstress.id,
          qty: 3,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(30),
          status: 'CANCELLED',
          approvalMode: 'AFTER_RELEASE',
          sourceEventType: 'OPERATION_TRANSITION',
        },
        {
          passportId: setup.passportId,
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          qty: 3,
          ratePerUnit: new Prisma.Decimal(0),
          amount: new Prisma.Decimal(0),
          status: 'REVERSED',
          approvalMode: 'AFTER_RELEASE',
          sourceEventType: 'OPERATION_TRANSITION',
        },
        {
          passportId: setup.passportId,
          operationId: seed.operations.CUT_CUT.id,
          employeeId: seed.employees.cutter.id,
          qty: 3,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(30),
          status: 'APPROVED',
          approvalMode: 'IMMEDIATE',
          sourceEventType: 'PASSPORT_CREATED',
          approvedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    });

    const count = await t.prisma.$transaction(
      async (tx) => earnings.approvePendingForPassport(tx, setup.passportId),
    );
    // Только PENDING_RELEASE/PENDING попадают в фильтр updateMany.
    expect(count).toBe(1);

    const rows = await t.prisma.operationEntry.findMany({
      where: { passportId: setup.passportId },
      orderBy: { sourceEventType: 'asc' },
    });
    const byOp = new Map(rows.map((r) => [r.operationId, r]));
    expect(byOp.get(seed.operations.SEW_OVERLOCK_1.id)!.status).toBe('APPROVED');
    expect(byOp.get(seed.operations.SEW_OVERLOCK_2.id)!.status).toBe('CANCELLED');
    expect(byOp.get(seed.operations.QC.id)!.status).toBe('REVERSED');
    // У уже APPROVED не сдвинули approvedAt.
    expect(
      byOp.get(seed.operations.CUT_CUT.id)!.approvedAt?.toISOString(),
    ).toBe('2026-01-01T00:00:00.000Z');
  });

  // ---------------------------------------------------------------------------
  // 8. Один паспорт — обе ветки сосуществуют (IMMEDIATE + AFTER_RELEASE)
  // ---------------------------------------------------------------------------

  test('один паспорт держит и IMMEDIATE/APPROVED (cutter), и AFTER_RELEASE/PENDING_RELEASE (швея)', async () => {
    const setup = await setupOrderWithPassport({
      divisionCode: 'MARKETPLACE',
      sizeKey: 'M',
      qtyPlan: 2,
      qtyCut: 2,
      routeStepCodes: ['SEW_OVERLOCK_1'],
    });

    await t.prisma.$transaction(async (tx) => {
      await earnings.createImmediateForCutter(tx, {
        passportId: setup.passportId,
        cutterId: seed.employees.cutter.id,
        sizeId: setup.sizeId,
        productId: seed.product.id,
        qty: 2,
      });
    });
    await t.prisma.$transaction(async (tx) => {
      await earnings.createPendingForCompletedOperation(tx, {
        passportId: setup.passportId,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        productId: seed.product.id,
        sizeId: setup.sizeId,
        qty: 2,
        sourceEventId: null,
      });
    });

    const cutter = await t.prisma.operationEntry.findFirstOrThrow({
      where: {
        passportId: setup.passportId,
        sourceEventType: 'PASSPORT_CREATED',
      },
    });
    const seamstress = await t.prisma.operationEntry.findFirstOrThrow({
      where: {
        passportId: setup.passportId,
        sourceEventType: 'OPERATION_TRANSITION',
      },
    });

    expect(cutter.status).toBe('APPROVED');
    expect(cutter.approvalMode).toBe('IMMEDIATE');
    expect(cutter.approvedAt).not.toBeNull();
    expect(cutter.employeeId).toBe(seed.employees.cutter.id);

    expect(seamstress.status).toBe('PENDING_RELEASE');
    expect(seamstress.approvalMode).toBe('AFTER_RELEASE');
    expect(seamstress.approvedAt).toBeNull();
    expect(seamstress.employeeId).toBe(seed.employees.seamstress.id);

    expect(await countEntries(setup.passportId)).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // 9. Composite-key invariant — нет дублей по (passport, op, emp, source)
  //    среди всего, что мы насоздавали в финальном сценарии.
  // ---------------------------------------------------------------------------

  test('инвариант: нет дублей по (passportId, operationId, employeeId, sourceEventType)', async () => {
    const setup = await setupOrderWithPassport({
      divisionCode: 'MARKETPLACE',
      sizeKey: 'M',
      qtyPlan: 5,
      qtyCut: 5,
      routeStepCodes: ['SEW_OVERLOCK_1'],
    });

    const trigger = () =>
      t.prisma.$transaction(async (tx) => {
        await earnings.createImmediateForCutter(tx, {
          passportId: setup.passportId,
          cutterId: seed.employees.cutter.id,
          sizeId: setup.sizeId,
          productId: seed.product.id,
          qty: 5,
        });
        await earnings.createPendingForCompletedOperation(tx, {
          passportId: setup.passportId,
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          employeeId: seed.employees.seamstress.id,
          productId: seed.product.id,
          sizeId: setup.sizeId,
          qty: 5,
          sourceEventId: null,
        });
      });

    // Несколько последовательных + параллельных trigger-ов.
    await trigger();
    await Promise.allSettled([trigger(), trigger(), trigger()]);

    const grouped = await t.prisma.operationEntry.groupBy({
      by: ['passportId', 'operationId', 'employeeId', 'sourceEventType'],
      where: { passportId: setup.passportId },
      _count: { _all: true },
    });
    for (const g of grouped) {
      expect(g._count._all).toBe(1);
    }
    // Всего ожидаем ровно две строки: одна cutter (PASSPORT_CREATED) и
    // одна seamstress (OPERATION_TRANSITION).
    expect(await countEntries(setup.passportId)).toBe(2);
  });
});
