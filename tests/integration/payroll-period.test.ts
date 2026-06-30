/**
 * Integration-тесты `/api/payroll/period` (PHASE 1, read-only).
 *
 * Источник истины — `apps/api/src/modules/payroll/payroll.service.ts`,
 * контракты — `packages/shared/src/payroll.ts`. Бизнес-правила —
 * `docs/api.md §10c`, `docs/domain.md §10.6`.
 *
 * Покрытие:
 *   1. Сводит сдельщину (`OperationEntry`) и оклад (`SalaryEntry`)
 *      в одну строку на сотрудника.
 *   2. Approved и pending сдельщина считаются раздельно
 *      (`pieceworkApprovedRub` / `pieceworkPendingRub`,
 *      `totalApproved = pieceworkApproved + salary`,
 *      `totalPending = pieceworkPending`).
 *   3. RBAC: SHOP_MANAGER / ADMIN получают 200; SEAMSTRESS / QC /
 *      PACKING / CUTTER → 403.
 *
 * Сценарии строим через Prisma напрямую — это бьёт именно по слою
 * чтения и не зависит от piecework-операций / тарифов.
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

describeWithDb('integration — payroll period (PHASE 1, read-only)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let passportId: string;
  const TODAY = '2026-05-02';
  const FROM = '2026-05-01';
  const TO = '2026-05-31';

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);

    const adminPin = await bcrypt.hash('payroll-admin', 4);
    const admin = await t.prisma.employee.upsert({
      where: { login: 'payroll-admin' },
      create: {
        login: 'payroll-admin',
        fullName: 'Payroll Admin',
        role: 'ADMIN',
        active: true,
        pinHash: adminPin,
      },
      update: { active: true, role: 'ADMIN', fullName: 'Payroll Admin' },
    });

    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      cutter: loginAs(t, seed.employees['cutter']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      packer: loginAs(t, seed.employees['packer']),
      admin: loginAs(t, {
        id: admin.id,
        role: admin.role,
        login: admin.login,
        fullName: admin.fullName,
      }),
    };

    // Сотрудники с разными compensationType — для проверки оси
    // «оклад × сдельщина».
    await t.prisma.employee.update({
      where: { id: seed.employees.qc.id },
      data: {
        compensationType: 'SALARY',
        salaryPerHour: new Prisma.Decimal(375),
      },
    });

    // Заказ → паспорт → 3 OperationEntry (cutter APPROVED,
    // seamstress APPROVED + PENDING_RELEASE).
    const order = await t.prisma.order.create({
      data: {
        number: 'O-PAYROLL-1',
        orderDate: new Date(`${TODAY}T08:00:00.000Z`),
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
        number: 'P-PAYROLL-1',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: 'R-PAYROLL',
        cutDate: new Date(`${TODAY}T08:00:00.000Z`),
        qtyPlan: 5,
        qtyCut: 5,
        qtyGood: 5,
        qrCode: `passport:payroll-${Date.now()}`,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
    passportId = passport.id;

    await t.prisma.operationEntry.createMany({
      data: [
        {
          passportId,
          operationId: seed.operations.CUT_CUT.id,
          employeeId: seed.employees.cutter.id,
          qty: 5,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(50),
          status: 'APPROVED',
          approvalMode: 'IMMEDIATE',
          sourceEventType: 'PASSPORT_CREATED',
          approvedAt: new Date(`${TODAY}T09:00:00.000Z`),
          createdAt: new Date(`${TODAY}T09:00:00.000Z`),
        },
        {
          passportId,
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          employeeId: seed.employees.seamstress.id,
          qty: 5,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(50),
          status: 'APPROVED',
          approvalMode: 'AFTER_RELEASE',
          sourceEventType: 'OPERATION_TRANSITION',
          approvedAt: new Date(`${TODAY}T10:00:00.000Z`),
          createdAt: new Date(`${TODAY}T10:00:00.000Z`),
        },
        {
          passportId,
          operationId: seed.operations.SEW_OVERLOCK_2.id,
          employeeId: seed.employees.seamstress.id,
          qty: 5,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(50),
          status: 'PENDING_RELEASE',
          approvalMode: 'AFTER_RELEASE',
          sourceEventType: 'OPERATION_TRANSITION',
          createdAt: new Date(`${TODAY}T11:00:00.000Z`),
        },
      ],
    });

    // SalaryEntry для QC за тот же день (имитация SHIFT_DAY).
    await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: new Date(`${TODAY}T00:00:00.000Z`),
        amount: new Prisma.Decimal(3000),
        source: 'SHIFT_DAY',
      },
    });

    // ShiftSession для QC (даёт `daysOnShift = 1`).
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.qc.id,
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
        startedAt: new Date(`${TODAY}T08:00:00.000Z`),
        endedAt: new Date(`${TODAY}T17:00:00.000Z`),
      },
    });
  });

  // -------------------------------------------------------------------------
  // 1. Aggregation
  // -------------------------------------------------------------------------

  test('manager: ведомость собирает сдельщину + оклад по сотрудникам', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/period')
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);

    expect(res.body.total).toBe(3);
    const items = res.body.items as Array<{
      employeeId: string;
      pieceworkApprovedRub: number;
      pieceworkPendingRub: number;
      salaryRub: number;
      totalApprovedRub: number;
      totalPendingRub: number;
      totalRub: number;
      daysOnShift: number;
      entriesCount: number;
    }>;

    const byId = new Map(items.map((r) => [r.employeeId, r]));

    const cutterRow = byId.get(seed.employees.cutter.id);
    expect(cutterRow).toBeDefined();
    expect(cutterRow!.pieceworkApprovedRub).toBeCloseTo(50, 2);
    expect(cutterRow!.pieceworkPendingRub).toBe(0);
    expect(cutterRow!.salaryRub).toBe(0);
    expect(cutterRow!.totalApprovedRub).toBeCloseTo(50, 2);
    expect(cutterRow!.totalPendingRub).toBe(0);
    expect(cutterRow!.totalRub).toBeCloseTo(50, 2);
    expect(cutterRow!.entriesCount).toBe(1);

    const seamstressRow = byId.get(seed.employees.seamstress.id);
    expect(seamstressRow).toBeDefined();
    expect(seamstressRow!.pieceworkApprovedRub).toBeCloseTo(50, 2);
    expect(seamstressRow!.pieceworkPendingRub).toBeCloseTo(50, 2);
    expect(seamstressRow!.salaryRub).toBe(0);
    expect(seamstressRow!.totalApprovedRub).toBeCloseTo(50, 2);
    expect(seamstressRow!.totalPendingRub).toBeCloseTo(50, 2);
    expect(seamstressRow!.totalRub).toBeCloseTo(100, 2);
    expect(seamstressRow!.entriesCount).toBe(2);

    const qcRow = byId.get(seed.employees.qc.id);
    expect(qcRow).toBeDefined();
    expect(qcRow!.pieceworkApprovedRub).toBe(0);
    expect(qcRow!.pieceworkPendingRub).toBe(0);
    expect(qcRow!.salaryRub).toBeCloseTo(3000, 2);
    expect(qcRow!.totalApprovedRub).toBeCloseTo(3000, 2);
    expect(qcRow!.totalPendingRub).toBe(0);
    expect(qcRow!.totalRub).toBeCloseTo(3000, 2);
    expect(qcRow!.daysOnShift).toBe(1);
    expect(qcRow!.entriesCount).toBe(0);
  });

  test('manager: summary считает approved и pending раздельно', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/period')
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);

    // Approved: 50 (cutter) + 50 (seamstress) + 3000 (qc-salary) = 3100
    // Pending:  50 (seamstress)
    // Total:    3150
    expect(res.body.summary.totalApprovedRub).toBeCloseTo(3100, 2);
    expect(res.body.summary.totalPendingRub).toBeCloseTo(50, 2);
    expect(res.body.summary.totalRub).toBeCloseTo(3150, 2);
    expect(res.body.summary.pieceworkRub).toBeCloseTo(150, 2);
    expect(res.body.summary.salaryRub).toBeCloseTo(3000, 2);
    expect(res.body.summary.employeesCount).toBe(3);
    expect(res.body.summary.pieceworkEntriesCount).toBe(3);
    expect(res.body.summary.pieceworkPendingCount).toBe(1);
    expect(res.body.summary.salaryEntriesCount).toBe(1);
  });

  test('manager: фильтр status=PENDING_RELEASE оставляет только pending-сдельщину', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/period')
      .query({ dateFrom: FROM, dateTo: TO, status: 'PENDING_RELEASE' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    // Только швея остаётся как «у кого есть сдельщина в pending».
    // QC попадает по SalaryEntry, но при status=PENDING_RELEASE
    // мы режем earningsWhere на pending → у QC нет earnings,
    // зато есть salary → она тоже остаётся через salaryEmps.
    const ids = (res.body.items as Array<{ employeeId: string }>).map(
      (r) => r.employeeId,
    );
    expect(ids).toContain(seed.employees.seamstress.id);
    expect(ids).not.toContain(seed.employees.cutter.id);
  });

  test('manager: фильтр employeeId возвращает ровно одну строку', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/period')
      .query({
        dateFrom: FROM,
        dateTo: TO,
        employeeId: seed.employees.seamstress.id,
      })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].employeeId).toBe(seed.employees.seamstress.id);
  });

  // -------------------------------------------------------------------------
  // 2. RBAC
  // -------------------------------------------------------------------------

  test('admin получает 200', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/period')
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.admin);
    expect(res.status).toBe(200);
  });

  test('SEAMSTRESS не имеет доступа к /api/payroll/period (403)', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/period')
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(403);
  });

  test('CUTTER не имеет доступа к /api/payroll/period (403)', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/period')
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.cutter);
    expect(res.status).toBe(403);
  });

  test('QC не имеет доступа к /api/payroll/period (403)', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/period')
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.qc);
    expect(res.status).toBe(403);
  });

  test('PACKING не имеет доступа к /api/payroll/period (403)', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/payroll/period')
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.packer);
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 3. Read-only sanity: payroll НЕ создаёт ни OperationEntry, ни SalaryEntry
  // -------------------------------------------------------------------------

  test('запрос payroll/period не пишет в БД (read-only)', async () => {
    // Используем passportId, чтобы линтер не ругался на unused.
    expect(passportId).toBeTruthy();
    const opsBefore = await t.prisma.operationEntry.count();
    const salBefore = await t.prisma.salaryEntry.count();
    await request(t.app.getHttpServer())
      .get('/api/payroll/period')
      .query({ dateFrom: FROM, dateTo: TO })
      .set('Cookie', cookies.manager)
      .expect(200);
    const opsAfter = await t.prisma.operationEntry.count();
    const salAfter = await t.prisma.salaryEntry.count();
    expect(opsAfter).toBe(opsBefore);
    expect(salAfter).toBe(salBefore);
  });
});
