/**
 * Integration-тесты «К выплате сейчас» (netToPayRub) в ведомости за период.
 *
 * Проверяем, что `/api/payroll/period` корректно считает:
 *   - `grossAccruedRub` = `pieceworkApprovedRub + salaryRub`
 *   - `payoutCoveredRub` = Σ активных `PayrollPayoutLine` за период
 *   - `netToPayRub` = `max(0, grossAccruedRub − payoutCoveredRub)`
 *
 * Сценарии:
 *   1. Нет выплат → netToPayRub = grossAccruedRub
 *   2. Начисления включены в ISSUED-выплату → netToPayRub = 0
 *   3. CANCELLED-выплата не уменьшает netToPayRub
 *   4. Частичное покрытие (только оклад выплачен) → netToPayRub = gross - salaryCovered
 *   5. Pending OperationEntry не влияет на netToPayRub
 *   6. Summary.totalPayoutCoveredRub и totalNetToPayRub корректны
 *
 * Источник: `apps/api/src/modules/payroll/payroll.service.ts`,
 * `packages/shared/src/payroll.ts`.
 * Бизнес-правило: `docs/domain.md §10.6`, `docs/api.md §10c`.
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

describeWithDb('integration — payroll period net-to-pay (PHASE 3)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let managerCookie: string;

  const DATE = '2026-06-15';
  const FROM = '2026-06-01';
  const TO = '2026-06-30';
  const IN_PERIOD = new Date('2026-06-15T10:00:00.000Z');
  const IN_PERIOD_DAY = new Date('2026-06-15T00:00:00.000Z');

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);

    const adminPin = await bcrypt.hash('netpay-admin', 4);
    const admin = await t.prisma.employee.upsert({
      where: { login: 'netpay-admin' },
      create: {
        login: 'netpay-admin',
        fullName: 'NetPay Admin',
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
  ) {
    const order = await t.prisma.order.create({
      data: {
        number: `O-NTP-${Date.now()}-${Math.random()}`,
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
        number: `P-NTP-${Date.now()}-${Math.random()}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: `R-NTP-${Date.now()}`,
        cutDate: IN_PERIOD,
        qtyPlan: 1,
        qtyCut: 1,
        qtyGood: 1,
        qrCode: `passport:ntp-${Date.now()}-${Math.random()}`,
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
        approvedAt: status === 'APPROVED' ? IN_PERIOD : null,
        createdAt: IN_PERIOD,
      },
    });
  }

  async function createSalaryEntry(employeeId: string, amount: number) {
    return t.prisma.salaryEntry.create({
      data: {
        employeeId,
        date: IN_PERIOD_DAY,
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
    }>,
  ) {
    const payout = await t.prisma.payrollPayout.create({
      data: {
        employeeId,
        periodFrom: new Date(`${FROM}T00:00:00.000Z`),
        periodTo: new Date(`${TO}T23:59:59.999Z`),
        status,
        amountPieceworkRub: new Prisma.Decimal(0),
        amountSalaryRub: new Prisma.Decimal(0),
        amountTotalRub: new Prisma.Decimal(0),
        createdById: seed.employees['shop-chief'].id,
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
          occurredOn: IN_PERIOD_DAY,
          snapshot: {},
        },
      });
    }
    return payout;
  }

  async function getPeriod() {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/period')
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', managerCookie)
      .expect(200);
    return res.body as {
      items: Array<{
        employeeId: string;
        grossAccruedRub: number;
        payoutCoveredRub: number;
        payoutPieceworkCoveredRub: number;
        payoutSalaryCoveredRub: number;
        netToPayRub: number;
        pieceworkApprovedRub: number;
        pieceworkPendingRub: number;
        salaryRub: number;
      }>;
      summary: {
        totalPayoutCoveredRub: number;
        totalNetToPayRub: number;
        totalApprovedRub: number;
      };
    };
  }

  // -------------------------------------------------------------------------
  // 1. Нет выплат → netToPayRub = grossAccruedRub
  // -------------------------------------------------------------------------

  test('1. без выплат: netToPayRub = grossAccruedRub', async () => {
    const oe = await createOperationEntry(seed.employees.cutter.id, 500);
    expect(oe).toBeDefined();
    await createSalaryEntry(seed.employees.cutter.id, 300);

    const data = await getPeriod();
    const row = data.items.find((r) => r.employeeId === seed.employees.cutter.id);
    expect(row).toBeDefined();
    expect(row!.grossAccruedRub).toBeCloseTo(800, 2);
    expect(row!.payoutCoveredRub).toBe(0);
    expect(row!.netToPayRub).toBeCloseTo(800, 2);
  });

  // -------------------------------------------------------------------------
  // 2. Начисления включены в ISSUED-выплату → netToPayRub = 0
  // -------------------------------------------------------------------------

  test('2. ISSUED-выплата покрывает начисления: netToPayRub = 0', async () => {
    const oe = await createOperationEntry(seed.employees.seamstress.id, 400);
    const se = await createSalaryEntry(seed.employees.seamstress.id, 200);

    await createPayout(seed.employees.seamstress.id, PayrollPayoutStatus.ISSUED, [
      { kind: PayrollPayoutLineKind.PIECEWORK, operationEntryId: oe.id, amount: 400 },
      { kind: PayrollPayoutLineKind.SALARY, salaryEntryId: se.id, amount: 200 },
    ]);

    const data = await getPeriod();
    const row = data.items.find((r) => r.employeeId === seed.employees.seamstress.id);
    expect(row).toBeDefined();
    expect(row!.grossAccruedRub).toBeCloseTo(600, 2);
    expect(row!.payoutCoveredRub).toBeCloseTo(600, 2);
    expect(row!.payoutPieceworkCoveredRub).toBeCloseTo(400, 2);
    expect(row!.payoutSalaryCoveredRub).toBeCloseTo(200, 2);
    expect(row!.netToPayRub).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. CANCELLED-выплата не уменьшает netToPayRub
  // -------------------------------------------------------------------------

  test('3. CANCELLED-выплата не влияет на netToPayRub', async () => {
    const oe = await createOperationEntry(seed.employees.cutter.id, 350);

    await createPayout(seed.employees.cutter.id, PayrollPayoutStatus.CANCELLED, [
      { kind: PayrollPayoutLineKind.PIECEWORK, operationEntryId: oe.id, amount: 350 },
    ]);

    const data = await getPeriod();
    const row = data.items.find((r) => r.employeeId === seed.employees.cutter.id);
    expect(row).toBeDefined();
    expect(row!.payoutCoveredRub).toBe(0);
    expect(row!.netToPayRub).toBeCloseTo(350, 2);
  });

  // -------------------------------------------------------------------------
  // 4. Частичное покрытие (только оклад выплачен)
  // -------------------------------------------------------------------------

  test('4. частичное покрытие — только оклад в выплате: netToPayRub = gross - salaryCovered', async () => {
    await createOperationEntry(seed.employees.seamstress.id, 500);
    const se = await createSalaryEntry(seed.employees.seamstress.id, 300);

    await createPayout(seed.employees.seamstress.id, PayrollPayoutStatus.DRAFT, [
      { kind: PayrollPayoutLineKind.SALARY, salaryEntryId: se.id, amount: 300 },
    ]);

    const data = await getPeriod();
    const row = data.items.find((r) => r.employeeId === seed.employees.seamstress.id);
    expect(row).toBeDefined();
    expect(row!.grossAccruedRub).toBeCloseTo(800, 2);
    expect(row!.payoutCoveredRub).toBeCloseTo(300, 2);
    expect(row!.payoutSalaryCoveredRub).toBeCloseTo(300, 2);
    expect(row!.payoutPieceworkCoveredRub).toBe(0);
    expect(row!.netToPayRub).toBeCloseTo(500, 2);
  });

  // -------------------------------------------------------------------------
  // 5. Pending OperationEntry не влияет на netToPayRub
  // -------------------------------------------------------------------------

  test('5. PENDING_RELEASE сдельщина не входит в netToPayRub', async () => {
    await createOperationEntry(seed.employees.cutter.id, 100, 'APPROVED');
    await createOperationEntry(seed.employees.cutter.id, 200, 'PENDING_RELEASE');

    const data = await getPeriod();
    const row = data.items.find((r) => r.employeeId === seed.employees.cutter.id);
    expect(row).toBeDefined();
    // grossAccruedRub учитывает только approved
    expect(row!.grossAccruedRub).toBeCloseTo(100, 2);
    expect(row!.pieceworkPendingRub).toBeCloseTo(200, 2);
    // netToPayRub = grossAccruedRub (нет выплат)
    expect(row!.netToPayRub).toBeCloseTo(100, 2);
  });

  // -------------------------------------------------------------------------
  // 6. Summary: totalPayoutCoveredRub + totalNetToPayRub
  // -------------------------------------------------------------------------

  test('6. summary.totalPayoutCoveredRub и totalNetToPayRub корректны', async () => {
    // Cutter: 300 gross, 300 covered → netToPay = 0
    const oe1 = await createOperationEntry(seed.employees.cutter.id, 300);
    await createPayout(seed.employees.cutter.id, PayrollPayoutStatus.ACKNOWLEDGED, [
      { kind: PayrollPayoutLineKind.PIECEWORK, operationEntryId: oe1.id, amount: 300 },
    ]);

    // Seamstress: 200 gross, 0 covered → netToPay = 200
    await createOperationEntry(seed.employees.seamstress.id, 200);

    const data = await getPeriod();
    expect(data.summary.totalPayoutCoveredRub).toBeCloseTo(300, 2);
    expect(data.summary.totalNetToPayRub).toBeCloseTo(200, 2);
  });
});
