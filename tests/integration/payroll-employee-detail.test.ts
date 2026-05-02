/**
 * Integration-тесты `/api/payroll/employees/:id` (PHASE 1, read-only).
 *
 * Источник истины — `apps/api/src/modules/payroll/payroll.service.ts`,
 * контракты — `packages/shared/src/payroll.ts`. Бизнес-правила —
 * `docs/api.md §10c`, `docs/domain.md §10.6`.
 *
 * Покрытие:
 *   1. Карточка возвращает реквизиты сотрудника + summary за период
 *      + три отдельных списка `shifts[]` / `operationEntries[]` /
 *      `salaryEntries[]`.
 *   2. Pending и approved сдельщина видны в `operationEntries[]`
 *      раздельно (через статус), summary считает их корректно.
 *   3. RBAC: SEAMSTRESS / QC / CUTTER / PACKING → 403.
 *   4. 404, если сотрудника нет.
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

describeWithDb('integration — payroll employee detail (PHASE 1)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  const FROM = '2026-05-01';
  const TO = '2026-05-31';
  const DAY = '2026-05-02';

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);

    const adminPin = await bcrypt.hash('payroll-emp-admin', 4);
    const admin = await t.prisma.employee.upsert({
      where: { login: 'payroll-emp-admin' },
      create: {
        login: 'payroll-emp-admin',
        fullName: 'Payroll Emp Admin',
        role: 'ADMIN',
        active: true,
        pinHash: adminPin,
      },
      update: {
        active: true,
        role: 'ADMIN',
        fullName: 'Payroll Emp Admin',
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

    // Заказ + паспорт + 2 OperationEntry для швеи (APPROVED + PENDING)
    // + 1 ShiftSession + 2 SalaryEntry (одна правленая).
    const order = await t.prisma.order.create({
      data: {
        number: 'O-PAYROLL-EMP-1',
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
        number: 'P-PAYROLL-EMP-1',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: 'R-PAYROLL-EMP',
        cutDate: new Date(`${DAY}T08:00:00.000Z`),
        qtyPlan: 5,
        qtyCut: 5,
        qtyGood: 5,
        qrCode: `passport:payroll-emp-${Date.now()}`,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
    await t.prisma.operationEntry.createMany({
      data: [
        {
          passportId: passport.id,
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          employeeId: seed.employees.seamstress.id,
          qty: 4,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(40),
          status: 'APPROVED',
          approvalMode: 'AFTER_RELEASE',
          sourceEventType: 'OPERATION_TRANSITION',
          approvedAt: new Date(`${DAY}T11:00:00.000Z`),
          createdAt: new Date(`${DAY}T10:00:00.000Z`),
        },
        {
          passportId: passport.id,
          operationId: seed.operations.SEW_OVERLOCK_2.id,
          employeeId: seed.employees.seamstress.id,
          qty: 4,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(40),
          status: 'PENDING_RELEASE',
          approvalMode: 'AFTER_RELEASE',
          sourceEventType: 'OPERATION_TRANSITION',
          createdAt: new Date(`${DAY}T12:00:00.000Z`),
        },
      ],
    });
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        startedAt: new Date(`${DAY}T08:00:00.000Z`),
        endedAt: new Date(`${DAY}T17:00:00.000Z`),
      },
    });
    await t.prisma.salaryEntry.createMany({
      data: [
        {
          employeeId: seed.employees.seamstress.id,
          date: new Date(`${DAY}T00:00:00.000Z`),
          amount: new Prisma.Decimal(1500),
          source: 'SHIFT_DAY',
          editedManually: true,
          managerComment: 'half-day',
          editedByEmployeeId: seed.employees['shop-chief'].id,
        },
        {
          employeeId: seed.employees.seamstress.id,
          date: new Date(`2026-05-03T00:00:00.000Z`),
          amount: new Prisma.Decimal(2500),
          source: 'SHIFT_DAY',
        },
      ],
    });
  });

  test('manager: карточка возвращает employee + summary + три списка', async () => {
    const res = await request(t.app.getHttpServer())
      .get(`/api/payroll/employees/${seed.employees.seamstress.id}`)
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);

    expect(res.body.employee.employeeId).toBe(seed.employees.seamstress.id);
    expect(res.body.employee.role).toBe(seed.employees.seamstress.role);

    expect(Array.isArray(res.body.shifts)).toBe(true);
    expect(res.body.shifts).toHaveLength(1);
    expect(Array.isArray(res.body.operationEntries)).toBe(true);
    expect(res.body.operationEntries).toHaveLength(2);
    expect(Array.isArray(res.body.salaryEntries)).toBe(true);
    expect(res.body.salaryEntries).toHaveLength(2);

    expect(res.body.summary.pieceworkApprovedRub).toBeCloseTo(40, 2);
    expect(res.body.summary.pieceworkPendingRub).toBeCloseTo(40, 2);
    expect(res.body.summary.salaryRub).toBeCloseTo(4000, 2);
    expect(res.body.summary.salaryEditedRub).toBeCloseTo(1500, 2);
    expect(res.body.summary.totalApprovedRub).toBeCloseTo(4040, 2);
    expect(res.body.summary.totalPendingRub).toBeCloseTo(40, 2);
    expect(res.body.summary.totalRub).toBeCloseTo(4080, 2);
    expect(res.body.summary.daysOnShift).toBe(1);
    expect(res.body.summary.entriesCount).toBe(2);
  });

  test('manager: pending и approved отдают как два разных статуса в operationEntries', async () => {
    const res = await request(t.app.getHttpServer())
      .get(`/api/payroll/employees/${seed.employees.seamstress.id}`)
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const statuses = (
      res.body.operationEntries as Array<{ status: string }>
    ).map((e) => e.status);
    expect(statuses).toContain('APPROVED');
    expect(statuses).toContain('PENDING_RELEASE');
  });

  test('manager: 404 для несуществующего сотрудника', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/employees/non-existent-id')
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(404);
  });

  test('admin получает 200', async () => {
    const res = await request(t.app.getHttpServer())
      .get(`/api/payroll/employees/${seed.employees.seamstress.id}`)
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.admin);
    expect(res.status).toBe(200);
  });

  test('SEAMSTRESS / QC / CUTTER / PACKING получают 403', async () => {
    for (const role of ['seamstress', 'qc', 'cutter', 'packer'] as const) {
      const res = await request(t.app.getHttpServer())
        .get(`/api/payroll/employees/${seed.employees.seamstress.id}`)
        .query({ dateFrom: FROM, dateTo: TO })
        .set('Cookie', cookies[role]);
      expect(res.status).toBe(403);
    }
  });
});
