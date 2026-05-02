/**
 * Integration-тесты `/api/payroll/daily` (PHASE 1, read-only).
 *
 * Источник истины — `apps/api/src/modules/payroll/payroll.service.ts`,
 * контракты — `packages/shared/src/payroll.ts`. Бизнес-правила —
 * `docs/api.md §10c`, `docs/domain.md §10.6`.
 *
 * Покрытие:
 *   1. Дневной снимок собирает в одной строке: смену + сдельщину +
 *      оклад за выбранный день.
 *   2. `hadShift` true только если `ShiftSession.startedAt` попал в
 *      окно дня; `shiftStartedAt = MIN`, `shiftStoppedAt = MAX` (или
 *      `null`, если хоть одна смена не закрыта).
 *   3. RBAC: SEAMSTRESS / QC / CUTTER / PACKING → 403.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — payroll daily (PHASE 1, read-only)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  const DAY = '2026-05-02';
  const OTHER_DAY = '2026-05-03';

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);

    const adminPin = await bcrypt.hash('payroll-daily-admin', 4);
    const admin = await t.prisma.employee.upsert({
      where: { login: 'payroll-daily-admin' },
      create: {
        login: 'payroll-daily-admin',
        fullName: 'Payroll Daily Admin',
        role: 'ADMIN',
        active: true,
        pinHash: adminPin,
      },
      update: {
        active: true,
        role: 'ADMIN',
        fullName: 'Payroll Daily Admin',
      },
    });

    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      admin: loginAs(t, {
        id: admin.id,
        role: admin.role,
        login: admin.login,
        fullName: admin.fullName,
      }),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      cutter: loginAs(t, seed.employees['cutter']),
      packer: loginAs(t, seed.employees['packer']),
    };

    await t.prisma.employee.update({
      where: { id: seed.employees.qc.id },
      data: {
        compensationType: 'SALARY',
        salaryPerShift: new Prisma.Decimal(3000),
      },
    });

    // Закрытая смена QC за DAY.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.qc.id,
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
        startedAt: new Date(`${DAY}T08:00:00.000Z`),
        endedAt: new Date(`${DAY}T17:00:00.000Z`),
      },
    });

    // Открытая смена швеи за DAY (endedAt = null → shiftStoppedAt =
    // null в ответе).
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        startedAt: new Date(`${DAY}T09:00:00.000Z`),
      },
    });

    // SalaryEntry за DAY для QC (имитация SHIFT_DAY).
    await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: new Date(`${DAY}T00:00:00.000Z`),
        amount: new Prisma.Decimal(3000),
        source: 'SHIFT_DAY',
      },
    });

    // Один заказ + паспорт + два OperationEntry за DAY (cutter
    // APPROVED, seamstress PENDING_RELEASE).
    const order = await t.prisma.order.create({
      data: {
        number: 'O-PAYROLL-D-1',
        orderDate: new Date(`${DAY}T08:00:00.000Z`),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M,
            qtyPlan: 5,
          },
        },
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: 'P-PAYROLL-D-1',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: 'R-PAYROLL-D',
        cutDate: new Date(`${DAY}T08:00:00.000Z`),
        qtyPlan: 5,
        qtyCut: 5,
        qtyGood: 5,
        qrCode: `passport:payroll-d-${Date.now()}`,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
    await t.prisma.operationEntry.createMany({
      data: [
        {
          passportId: passport.id,
          operationId: seed.operations.CUT_CUT.id,
          employeeId: seed.employees.cutter.id,
          qty: 4,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(40),
          status: 'APPROVED',
          approvalMode: 'IMMEDIATE',
          sourceEventType: 'PASSPORT_CREATED',
          approvedAt: new Date(`${DAY}T09:30:00.000Z`),
          createdAt: new Date(`${DAY}T09:30:00.000Z`),
        },
        {
          passportId: passport.id,
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          employeeId: seed.employees.seamstress.id,
          qty: 4,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(40),
          status: 'PENDING_RELEASE',
          approvalMode: 'AFTER_RELEASE',
          sourceEventType: 'OPERATION_TRANSITION',
          createdAt: new Date(`${DAY}T11:00:00.000Z`),
        },
      ],
    });
  });

  test('manager: дневной снимок собирает смены и суммы за день', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/daily')
      .query({ date: DAY })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(DAY);

    const rows = res.body.employees as Array<{
      employeeId: string;
      hadShift: boolean;
      shiftStartedAt: string | null;
      shiftStoppedAt: string | null;
      salaryRub: number;
      pieceworkApprovedRub: number;
      pieceworkPendingRub: number;
      totalRub: number;
    }>;
    const byId = new Map(rows.map((r) => [r.employeeId, r]));

    const qc = byId.get(seed.employees.qc.id);
    expect(qc).toBeDefined();
    expect(qc!.hadShift).toBe(true);
    expect(qc!.shiftStartedAt).toBeTruthy();
    expect(qc!.shiftStoppedAt).toBeTruthy();
    expect(qc!.salaryRub).toBeCloseTo(3000, 2);
    expect(qc!.pieceworkApprovedRub).toBe(0);

    const seamstress = byId.get(seed.employees.seamstress.id);
    expect(seamstress).toBeDefined();
    expect(seamstress!.hadShift).toBe(true);
    expect(seamstress!.shiftStartedAt).toBeTruthy();
    // Смена не закрыта → shiftStoppedAt должен быть null.
    expect(seamstress!.shiftStoppedAt).toBeNull();
    expect(seamstress!.pieceworkPendingRub).toBeCloseTo(40, 2);

    const cutter = byId.get(seed.employees.cutter.id);
    expect(cutter).toBeDefined();
    expect(cutter!.hadShift).toBe(false);
    expect(cutter!.pieceworkApprovedRub).toBeCloseTo(40, 2);
  });

  test('manager: за другой день строки нет', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/daily')
      .query({ date: OTHER_DAY })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.employees).toHaveLength(0);
    expect(res.body.summary.employeesCount).toBe(0);
  });

  test('manager: summary суммирует employees / shifts / суммы', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/daily')
      .query({ date: DAY })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.summary.shiftsCount).toBe(2);
    expect(res.body.summary.salaryRub).toBeCloseTo(3000, 2);
    expect(res.body.summary.pieceworkApprovedRub).toBeCloseTo(40, 2);
    expect(res.body.summary.pieceworkPendingRub).toBeCloseTo(40, 2);
    expect(res.body.summary.totalRub).toBeCloseTo(3080, 2);
  });

  // -------------------------------------------------------------------------
  // RBAC
  // -------------------------------------------------------------------------

  test('admin получает 200', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/daily')
      .query({ date: DAY })
      .set('Cookie', cookies.admin);
    expect(res.status).toBe(200);
  });

  test('SEAMSTRESS / QC / CUTTER / PACKING получают 403', async () => {
    for (const role of ['seamstress', 'qc', 'cutter', 'packer'] as const) {
      const res = await request(t.app.getHttpServer())
        .get('/api/payroll/daily')
        .query({ date: DAY })
        .set('Cookie', cookies[role]);
      expect(res.status).toBe(403);
    }
  });
});
