/**
 * Integration-тесты «Задолженность по сотрудникам» — PHASE 3 STEP 7.
 *
 * Проверяем, что `GET /api/payroll/debts` корректно считает:
 *   - `accruedGrossRub`  = `accruedPieceworkRub + accruedSalaryRub`
 *   - `payoutCoveredRub` = Σ активных PIECEWORK/SALARY PayrollPayoutLine
 *   - `debtRub`          = `max(0, accruedGrossRub − payoutCoveredRub)`
 *   - `cashBalanceRub`   = `accruedGrossRub − paidTotalRub`
 *
 * Сценарии:
 *   1. approved OperationEntry + SalaryEntry без payout → debtRub = accruedGrossRub
 *   2. PIECEWORK/SALARY payout закрывает начисления → debtRub уменьшается
 *   3. ACKNOWLEDGED payout учитывается (debtRub = 0)
 *   4. CANCELLED payout не учитывается → debtRub = accruedGrossRub
 *   5. ADJUSTMENT не уменьшает debtRub как coverage
 *   6. negative ADJUSTMENT влияет на cashBalanceRub
 *   7. pending OperationEntry попадает только в pendingPieceworkRub
 *   8. asOfDate исключает начисления после даты
 *   9. фильтр по employeeId
 *  10. фильтр по role
 *
 * Источник: `apps/api/src/modules/payroll/payroll.service.ts::debts`,
 * `packages/shared/src/payroll.ts::PayrollDebtsQuerySchema`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { Prisma, PayrollPayoutStatus, PayrollPayoutLineKind } from '@prisma/client';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — payroll debts (PHASE 3 STEP 7)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let managerCookie: string;

  const AS_OF_DATE = '2026-06-20';
  const BEFORE_DATE = '2026-06-15';
  const AFTER_DATE = '2026-06-25';

  const IN_PERIOD = new Date('2026-06-15T10:00:00.000Z');
  const IN_PERIOD_DAY = new Date('2026-06-15T00:00:00.000Z');
  const AFTER_CUT = new Date('2026-06-22T10:00:00.000Z');
  const AFTER_CUT_DAY = new Date('2026-06-22T00:00:00.000Z');

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);

    const adminPin = await bcrypt.hash('debts-admin', 4);
    const admin = await t.prisma.employee.upsert({
      where: { login: 'debts-admin' },
      create: {
        login: 'debts-admin',
        fullName: 'Debts Admin',
        role: 'ADMIN',
        active: true,
        pinHash: adminPin,
      },
      update: { active: true, role: 'ADMIN' },
    });
    managerCookie = loginAs(t, {
      id: admin.id,
      role: admin.role,
      login: admin.login,
      fullName: admin.fullName,
    });
  });

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  async function createOperationEntry(
    employeeId: string,
    amount: number,
    status: 'APPROVED' | 'PENDING_RELEASE' = 'APPROVED',
    createdAt: Date = IN_PERIOD,
  ) {
    const order = await t.prisma.order.create({
      data: {
        number: `O-DEB-${Date.now()}-${Math.random()}`,
        orderDate: IN_PERIOD,
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M,
            qtyPlan: 1,
          },
        },
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-DEB-${Date.now()}-${Math.random()}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: `R-DEB-${Date.now()}`,
        cutDate: IN_PERIOD,
        qtyPlan: 1,
        qtyCut: 1,
        qtyGood: 1,
        qrCode: `passport:deb-${Date.now()}-${Math.random()}`,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
    return t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.CUT_CUT.id,
        employeeId,
        qty: 1,
        ratePerUnit: new Prisma.Decimal(amount),
        amount: new Prisma.Decimal(amount),
        status,
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: status === 'APPROVED' ? createdAt : null,
        createdAt,
      },
    });
  }

  async function createSalaryEntry(
    employeeId: string,
    amount: number,
    date: Date = IN_PERIOD_DAY,
  ) {
    return t.prisma.salaryEntry.create({
      data: {
        employeeId,
        date,
        amount: new Prisma.Decimal(amount),
        source: 'SHIFT_DAY',
      },
    });
  }

  async function createPayout(
    employeeId: string,
    status: PayrollPayoutStatus,
    lines: Array<{
      kind: PayrollPayoutLineKind;
      operationEntryId?: string;
      salaryEntryId?: string;
      amount: number;
      occurredOn?: Date;
    }>,
    periodTo: Date = IN_PERIOD_DAY,
  ) {
    const payout = await t.prisma.payrollPayout.create({
      data: {
        employeeId,
        periodFrom: new Date('2026-06-01T00:00:00.000Z'),
        periodTo,
        status,
        amountPieceworkRub: new Prisma.Decimal(0),
        amountSalaryRub: new Prisma.Decimal(0),
        amountTotalRub: new Prisma.Decimal(0),
        createdById: seed.employees['shop-chief'].id,
        issuedAt: status !== 'DRAFT' ? IN_PERIOD : null,
        acknowledgedAt: status === 'ACKNOWLEDGED' ? IN_PERIOD : null,
        acknowledgedByEmployeeId: status === 'ACKNOWLEDGED' ? employeeId : null,
      },
    });
    for (const l of lines) {
      await t.prisma.payrollPayoutLine.create({
        data: {
          payoutId: payout.id,
          kind: l.kind,
          operationEntryId: l.operationEntryId ?? null,
          salaryEntryId: l.salaryEntryId ?? null,
          amountRub: new Prisma.Decimal(l.amount),
          occurredOn: l.occurredOn ?? IN_PERIOD_DAY,
          snapshot: {},
        },
      });
    }
    return payout;
  }

  async function getDebts(params: Record<string, string | number> = {}) {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/debts')
      .query({ asOfDate: AS_OF_DATE, ...params })
      .set('Cookie', managerCookie)
      .expect(200);
    return res.body as {
      asOfDate: string;
      items: Array<{
        employeeId: string;
        accruedPieceworkRub: number;
        accruedSalaryRub: number;
        accruedGrossRub: number;
        payoutCoveredRub: number;
        payoutCoveredPieceworkRub: number;
        payoutCoveredSalaryRub: number;
        payoutAdjustRub: number;
        paidTotalRub: number;
        debtRub: number;
        cashBalanceRub: number;
        pendingPieceworkRub: number;
        lastPayoutAt: string | null;
        lastAcknowledgedAt: string | null;
      }>;
      summary: {
        totalAccruedGrossRub: number;
        totalPayoutCoveredRub: number;
        totalPayoutAdjustRub: number;
        totalPaidRub: number;
        totalDebtRub: number;
        totalCashBalanceRub: number;
        totalPendingPieceworkRub: number;
        employeesWithDebt: number;
      };
      total: number;
    };
  }

  // ---------------------------------------------------------------------------
  // 1. approved OperationEntry + SalaryEntry без payout → debtRub = accruedGrossRub
  // ---------------------------------------------------------------------------

  test('1. нет выплат: debtRub = accruedGrossRub', async () => {
    await createOperationEntry(seed.employees.cutter.id, 500);
    await createSalaryEntry(seed.employees.cutter.id, 300);

    const data = await getDebts();
    const row = data.items.find((r) => r.employeeId === seed.employees.cutter.id);
    expect(row).toBeDefined();
    expect(row!.accruedPieceworkRub).toBeCloseTo(500, 2);
    expect(row!.accruedSalaryRub).toBeCloseTo(300, 2);
    expect(row!.accruedGrossRub).toBeCloseTo(800, 2);
    expect(row!.payoutCoveredRub).toBe(0);
    expect(row!.debtRub).toBeCloseTo(800, 2);
    expect(row!.cashBalanceRub).toBeCloseTo(800, 2);
  });

  // ---------------------------------------------------------------------------
  // 2. PIECEWORK/SALARY payout закрывает начисления → debtRub уменьшается
  // ---------------------------------------------------------------------------

  test('2. ISSUED payout закрывает начисления: debtRub = 0', async () => {
    const oe = await createOperationEntry(seed.employees.seamstress.id, 400);
    const se = await createSalaryEntry(seed.employees.seamstress.id, 200);

    await createPayout(seed.employees.seamstress.id, PayrollPayoutStatus.ISSUED, [
      { kind: PayrollPayoutLineKind.PIECEWORK, operationEntryId: oe.id, amount: 400 },
      { kind: PayrollPayoutLineKind.SALARY, salaryEntryId: se.id, amount: 200 },
    ]);

    const data = await getDebts();
    const row = data.items.find((r) => r.employeeId === seed.employees.seamstress.id);
    expect(row).toBeDefined();
    expect(row!.accruedGrossRub).toBeCloseTo(600, 2);
    expect(row!.payoutCoveredRub).toBeCloseTo(600, 2);
    expect(row!.payoutCoveredPieceworkRub).toBeCloseTo(400, 2);
    expect(row!.payoutCoveredSalaryRub).toBeCloseTo(200, 2);
    expect(row!.debtRub).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 3. ACKNOWLEDGED payout учитывается (debtRub = 0)
  // ---------------------------------------------------------------------------

  test('3. ACKNOWLEDGED payout учитывается в payoutCoveredRub', async () => {
    const oe = await createOperationEntry(seed.employees.cutter.id, 700);

    await createPayout(seed.employees.cutter.id, PayrollPayoutStatus.ACKNOWLEDGED, [
      { kind: PayrollPayoutLineKind.PIECEWORK, operationEntryId: oe.id, amount: 700 },
    ]);

    const data = await getDebts();
    const row = data.items.find((r) => r.employeeId === seed.employees.cutter.id);
    expect(row).toBeDefined();
    expect(row!.payoutCoveredRub).toBeCloseTo(700, 2);
    expect(row!.debtRub).toBe(0);
    expect(row!.lastAcknowledgedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 4. CANCELLED payout не учитывается
  // ---------------------------------------------------------------------------

  test('4. CANCELLED payout не уменьшает debtRub', async () => {
    const oe = await createOperationEntry(seed.employees.cutter.id, 350);

    await createPayout(seed.employees.cutter.id, PayrollPayoutStatus.CANCELLED, [
      { kind: PayrollPayoutLineKind.PIECEWORK, operationEntryId: oe.id, amount: 350 },
    ]);

    const data = await getDebts();
    const row = data.items.find((r) => r.employeeId === seed.employees.cutter.id);
    expect(row).toBeDefined();
    expect(row!.payoutCoveredRub).toBe(0);
    expect(row!.debtRub).toBeCloseTo(350, 2);
  });

  // ---------------------------------------------------------------------------
  // 5. ADJUSTMENT не уменьшает debtRub как coverage
  // ---------------------------------------------------------------------------

  test('5. ADJUSTMENT PayrollPayoutLine не уменьшает debtRub', async () => {
    const oe = await createOperationEntry(seed.employees.cutter.id, 200);

    // Выплата с PIECEWORK (закрывает oe) + ADJUSTMENT (ручной бонус)
    const payout = await t.prisma.payrollPayout.create({
      data: {
        employeeId: seed.employees.cutter.id,
        periodFrom: new Date('2026-06-01T00:00:00.000Z'),
        periodTo: IN_PERIOD_DAY,
        status: 'ISSUED',
        amountPieceworkRub: new Prisma.Decimal(200),
        amountSalaryRub: new Prisma.Decimal(0),
        amountTotalRub: new Prisma.Decimal(250),
        createdById: seed.employees['shop-chief'].id,
        issuedAt: IN_PERIOD,
        issuedById: seed.employees['shop-chief'].id,
      },
    });
    await t.prisma.payrollPayoutLine.create({
      data: {
        payoutId: payout.id,
        kind: PayrollPayoutLineKind.PIECEWORK,
        operationEntryId: oe.id,
        amountRub: new Prisma.Decimal(200),
        occurredOn: IN_PERIOD_DAY,
        snapshot: {},
      },
    });
    await t.prisma.payrollPayoutLine.create({
      data: {
        payoutId: payout.id,
        kind: 'ADJUSTMENT' as PayrollPayoutLineKind,
        operationEntryId: null,
        salaryEntryId: null,
        amountRub: new Prisma.Decimal(50),
        occurredOn: IN_PERIOD_DAY,
        snapshot: { manual: true },
      },
    });

    const data = await getDebts();
    const row = data.items.find((r) => r.employeeId === seed.employees.cutter.id);
    expect(row).toBeDefined();

    // PIECEWORK закрывает базовое начисление
    expect(row!.accruedGrossRub).toBeCloseTo(200, 2);
    expect(row!.payoutCoveredRub).toBeCloseTo(200, 2);
    expect(row!.debtRub).toBe(0);

    // ADJUSTMENT учитывается в payoutAdjustRub и paidTotalRub
    expect(row!.payoutAdjustRub).toBeCloseTo(50, 2);
    expect(row!.paidTotalRub).toBeCloseTo(250, 2);

    // cashBalanceRub = accruedGrossRub - paidTotalRub = 200 - 250 = -50
    expect(row!.cashBalanceRub).toBeCloseTo(-50, 2);
  });

  // ---------------------------------------------------------------------------
  // 6. negative ADJUSTMENT влияет на cashBalanceRub
  // ---------------------------------------------------------------------------

  test('6. negative ADJUSTMENT (удержание) уменьшает cashBalanceRub', async () => {
    const oe = await createOperationEntry(seed.employees.seamstress.id, 300);

    const payout = await t.prisma.payrollPayout.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        periodFrom: new Date('2026-06-01T00:00:00.000Z'),
        periodTo: IN_PERIOD_DAY,
        status: 'ISSUED',
        amountPieceworkRub: new Prisma.Decimal(300),
        amountSalaryRub: new Prisma.Decimal(0),
        amountTotalRub: new Prisma.Decimal(250),
        createdById: seed.employees['shop-chief'].id,
        issuedAt: IN_PERIOD,
        issuedById: seed.employees['shop-chief'].id,
      },
    });
    await t.prisma.payrollPayoutLine.create({
      data: {
        payoutId: payout.id,
        kind: PayrollPayoutLineKind.PIECEWORK,
        operationEntryId: oe.id,
        amountRub: new Prisma.Decimal(300),
        occurredOn: IN_PERIOD_DAY,
        snapshot: {},
      },
    });
    // Удержание -50
    await t.prisma.payrollPayoutLine.create({
      data: {
        payoutId: payout.id,
        kind: 'DEDUCTION' as PayrollPayoutLineKind,
        operationEntryId: null,
        salaryEntryId: null,
        amountRub: new Prisma.Decimal(-50),
        occurredOn: IN_PERIOD_DAY,
        snapshot: { manual: true },
      },
    });

    const data = await getDebts();
    const row = data.items.find((r) => r.employeeId === seed.employees.seamstress.id);
    expect(row).toBeDefined();
    expect(row!.debtRub).toBe(0); // базовый долг закрыт
    expect(row!.payoutAdjustRub).toBeCloseTo(-50, 2);
    expect(row!.paidTotalRub).toBeCloseTo(250, 2);
    // cashBalanceRub = 300 - 250 = 50 (не получил удержанные 50)
    expect(row!.cashBalanceRub).toBeCloseTo(50, 2);
  });

  // ---------------------------------------------------------------------------
  // 7. pending OperationEntry попадает только в pendingPieceworkRub
  // ---------------------------------------------------------------------------

  test('7. PENDING_RELEASE только в pendingPieceworkRub, не в debtRub', async () => {
    await createOperationEntry(seed.employees.cutter.id, 100, 'APPROVED');
    await createOperationEntry(seed.employees.cutter.id, 200, 'PENDING_RELEASE');

    const data = await getDebts();
    const row = data.items.find((r) => r.employeeId === seed.employees.cutter.id);
    expect(row).toBeDefined();
    expect(row!.accruedGrossRub).toBeCloseTo(100, 2); // только approved
    expect(row!.pendingPieceworkRub).toBeCloseTo(200, 2);
    expect(row!.debtRub).toBeCloseTo(100, 2);
  });

  // ---------------------------------------------------------------------------
  // 8. asOfDate исключает начисления после даты
  // ---------------------------------------------------------------------------

  test('8. asOfDate: начисления после cutoff не включаются', async () => {
    // В период до AS_OF_DATE (2026-06-20)
    await createOperationEntry(seed.employees.cutter.id, 300, 'APPROVED', IN_PERIOD);
    // После AS_OF_DATE (2026-06-22)
    await createOperationEntry(
      seed.employees.cutter.id,
      400,
      'APPROVED',
      AFTER_CUT,
    );

    const data = await getDebts();
    const row = data.items.find((r) => r.employeeId === seed.employees.cutter.id);
    expect(row).toBeDefined();
    // Только первое начисление входит
    expect(row!.accruedGrossRub).toBeCloseTo(300, 2);
    expect(row!.debtRub).toBeCloseTo(300, 2);
  });

  // ---------------------------------------------------------------------------
  // 9. фильтр по employeeId
  // ---------------------------------------------------------------------------

  test('9. фильтр employeeId: возвращает только нужного сотрудника', async () => {
    await createOperationEntry(seed.employees.cutter.id, 100);
    await createOperationEntry(seed.employees.seamstress.id, 200);

    const data = await getDebts({ employeeId: seed.employees.cutter.id });
    expect(data.items.length).toBe(1);
    expect(data.items[0].employeeId).toBe(seed.employees.cutter.id);
    expect(data.total).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 10. фильтр по role
  // ---------------------------------------------------------------------------

  test('10. фильтр role: CUTTER, SEAMSTRESS видны только своей ролью', async () => {
    await createOperationEntry(seed.employees.cutter.id, 100);
    await createOperationEntry(seed.employees.seamstress.id, 200);

    const dataCutter = await getDebts({ role: 'CUTTER' });
    expect(dataCutter.items.every((r) => r.employeeId === seed.employees.cutter.id)).toBe(true);

    const dataSeam = await getDebts({ role: 'SEAMSTRESS' });
    expect(dataSeam.items.every((r) => r.employeeId === seed.employees.seamstress.id)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // summary checks
  // ---------------------------------------------------------------------------

  test('summary: employeesWithDebt считается корректно', async () => {
    // cutter: 100 без выплаты → debtRub = 100
    await createOperationEntry(seed.employees.cutter.id, 100);

    // seamstress: 200 полностью закрыто → debtRub = 0
    const oe = await createOperationEntry(seed.employees.seamstress.id, 200);
    await createPayout(seed.employees.seamstress.id, PayrollPayoutStatus.ISSUED, [
      { kind: PayrollPayoutLineKind.PIECEWORK, operationEntryId: oe.id, amount: 200 },
    ]);

    const data = await getDebts();
    expect(data.summary.employeesWithDebt).toBe(1);
    expect(data.summary.totalDebtRub).toBeCloseTo(100, 2);
    expect(data.summary.totalAccruedGrossRub).toBeCloseTo(300, 2);
    expect(data.summary.totalPayoutCoveredRub).toBeCloseTo(200, 2);
  });
});
