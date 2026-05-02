/**
 * Integration-тесты модуля окладных начислений (post-Шаг 18 / Шаг 19,
 * ADR-0021). См. контракт `docs/api.md §10a`, бизнес-правила
 * `docs/domain.md §9a`.
 *
 * Покрытие:
 *   1. SALARY-сотрудник с открытой сменой получает дневное начисление.
 *   2. PIECEWORK-сотрудник дневного начисления НЕ получает.
 *   3. MIXED-сотрудник получает оклад + сохраняет сдельщину.
 *   4. На один день одного сотрудника создаётся ровно одна запись
 *      (повторный start/stop не плодит дубли).
 *   5. Менеджер ручной правкой меняет amount + ставит editedManually.
 *   6. Автосинхронизация после ручной правки НЕ затирает amount.
 *   7. RBAC: обычный сотрудник видит только свои окладные;
 *      обычный сотрудник не может PATCH чужую запись;
 *      обычный сотрудник не может PATCH employees.
 *   8. RBAC employees: GET /api/employees доступен только менеджеру.
 *
 * Полный pipeline (auth, валидация, сервис) — реальный AppModule.
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

describeWithDb('integration — salary entries (ADR-0021)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let adminCookie: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);

    // Восстанавливаем системного admin после truncate.
    const adminPin = await bcrypt.hash('salary-admin', 4);
    const admin = await t.prisma.employee.upsert({
      where: { login: 'salary-admin' },
      create: {
        login: 'salary-admin',
        fullName: 'Salary Admin',
        role: 'ADMIN',
        active: true,
        pinHash: adminPin,
      },
      update: { active: true, role: 'ADMIN', fullName: 'Salary Admin' },
    });
    adminCookie = loginAs(t, {
      id: admin.id,
      role: admin.role,
      login: admin.login,
      fullName: admin.fullName,
    });

    // ОТК / упаковка — на оклад с ставкой; сменим тип компенсации.
    await t.prisma.employee.update({
      where: { id: seed.employees.qc.id },
      data: {
        compensationType: 'SALARY',
        salaryPerShift: new Prisma.Decimal(3000),
      },
    });
    await t.prisma.employee.update({
      where: { id: seed.employees.packer.id },
      data: {
        compensationType: 'MIXED',
        salaryPerShift: new Prisma.Decimal(2500),
      },
    });
    // Швея остаётся PIECEWORK.

    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      qc: loginAs(t, seed.employees['qc']),
      packer: loginAs(t, seed.employees['packer']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      cutter: loginAs(t, seed.employees['cutter']),
      admin: adminCookie,
    };
  });

  // -------------------------------------------------------------------------
  // 1. SALARY: shift opens → salary entry appears
  // -------------------------------------------------------------------------

  test('SALARY-сотрудник: открытие смены создаёт дневной оклад', async () => {
    const start = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      });
    expect(start.status).toBeLessThan(300);

    const list = await request(t.app.getHttpServer())
      .get('/api/salary')
      .set('Cookie', cookies.qc);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].employeeId).toBe(seed.employees.qc.id);
    expect(list.body.items[0].amount).toBeCloseTo(3000, 2);
    expect(list.body.items[0].source).toBe('SHIFT_DAY');
    expect(list.body.items[0].editedManually).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. PIECEWORK: shift opens → NO salary entry
  // -------------------------------------------------------------------------

  test('PIECEWORK-сотрудник: открытие смены НЕ создаёт окладного начисления', async () => {
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect((res) => {
        if (res.status >= 300) {
          throw new Error(
            `start shift failed: ${res.status} ${JSON.stringify(res.body)}`,
          );
        }
      });

    const list = await request(t.app.getHttpServer())
      .get('/api/salary')
      .query({ employeeId: seed.employees.seamstress.id })
      .set('Cookie', cookies.manager);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. MIXED: salary appears, piecework still works
  // -------------------------------------------------------------------------

  test('MIXED-сотрудник: открытие смены создаёт оклад и не мешает сдельщине', async () => {
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.packer)
      .send({
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
      })
      .expect((res) => {
        if (res.status >= 300) {
          throw new Error(
            `start shift failed: ${res.status} ${JSON.stringify(res.body)}`,
          );
        }
      });

    // Окладная запись создана.
    const salary = await request(t.app.getHttpServer())
      .get('/api/salary')
      .query({ employeeId: seed.employees.packer.id })
      .set('Cookie', cookies.manager);
    expect(salary.status).toBe(200);
    expect(salary.body.total).toBe(1);
    expect(salary.body.items[0].amount).toBeCloseTo(2500, 2);

    // Сдельщина: руками создаём piecework-строку для упаковщика и
    // убеждаемся, что она существует параллельно с окладной (т.е. модель
    // оклада не «запретила» piecework).
    const passport = await createPassport(t, seed);
    await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.packer.id,
        qty: 3,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(30),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: new Date(),
      },
    });
    const earnings = await request(t.app.getHttpServer())
      .get('/api/earnings')
      .query({ employeeId: seed.employees.packer.id })
      .set('Cookie', cookies.manager);
    expect(earnings.status).toBe(200);
    expect(earnings.body.total).toBe(1);
    expect(earnings.body.items[0].amount).toBeCloseTo(30, 2);
  });

  // -------------------------------------------------------------------------
  // 4. NO DUPLICATES per (employee, day)
  // -------------------------------------------------------------------------

  test('повторный start/stop в один день не плодит окладные дубли', async () => {
    // start → stop → start → stop → start (5 sync-вызовов).
    const startReq = () =>
      request(t.app.getHttpServer())
        .post('/api/shifts/start')
        .set('Cookie', cookies.qc)
        .send({
          equipmentId: seed.equipment['qc-station-01'].id,
          operationId: seed.operations.QC.id,
        });
    const stopReq = () =>
      request(t.app.getHttpServer())
        .post('/api/shifts/stop')
        .set('Cookie', cookies.qc)
        .send({});

    await startReq().expect((r) => {
      if (r.status >= 300) throw new Error(JSON.stringify(r.body));
    });
    await stopReq().expect((r) => {
      if (r.status >= 300) throw new Error(JSON.stringify(r.body));
    });
    await startReq().expect((r) => {
      if (r.status >= 300) throw new Error(JSON.stringify(r.body));
    });
    await stopReq().expect((r) => {
      if (r.status >= 300) throw new Error(JSON.stringify(r.body));
    });
    await startReq().expect((r) => {
      if (r.status >= 300) throw new Error(JSON.stringify(r.body));
    });

    const rows = await t.prisma.salaryEntry.findMany({
      where: { employeeId: seed.employees.qc.id },
    });
    expect(rows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 5. MANUAL ADJUSTMENT
  // -------------------------------------------------------------------------

  test('менеджер вручную правит amount + комментарий, ставится editedManually', async () => {
    const entry = await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: new Date('2026-04-15'),
        amount: new Prisma.Decimal(3000),
        source: 'SHIFT_DAY',
      },
    });
    const res = await request(t.app.getHttpServer())
      .patch(`/api/salary/${entry.id}`)
      .set('Cookie', cookies.manager)
      .send({ amount: 4500, managerComment: 'Переработка' });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBeCloseTo(4500, 2);
    expect(res.body.managerComment).toBe('Переработка');
    expect(res.body.editedManually).toBe(true);
    expect(res.body.editedByEmployeeId).toBe(seed.employees['shop-chief'].id);
  });

  // -------------------------------------------------------------------------
  // 6. AUTO-SYNC RESPECTS editedManually
  // -------------------------------------------------------------------------

  test('автосинхронизация не затирает вручную исправленный amount', async () => {
    // Готовим entry с ручной правкой.
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: day,
        amount: new Prisma.Decimal(9999),
        source: 'SHIFT_DAY',
        editedManually: true,
        managerComment: 'Особый случай',
      },
    });

    // Стартуем смену в этот же день — sync должен оставить amount
    // неизменным.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      })
      .expect((r) => {
        if (r.status >= 300) throw new Error(JSON.stringify(r.body));
      });

    const rows = await t.prisma.salaryEntry.findMany({
      where: { employeeId: seed.employees.qc.id },
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBeCloseTo(9999, 2);
    expect(rows[0].editedManually).toBe(true);
    expect(rows[0].managerComment).toBe('Особый случай');
  });

  // -------------------------------------------------------------------------
  // 7. RBAC: salary visibility / editing
  // -------------------------------------------------------------------------

  test('обычный сотрудник видит только свои окладные', async () => {
    // Две записи на разных сотрудников.
    await t.prisma.salaryEntry.createMany({
      data: [
        {
          employeeId: seed.employees.qc.id,
          date: new Date('2026-04-10'),
          amount: new Prisma.Decimal(3000),
          source: 'SHIFT_DAY',
        },
        {
          employeeId: seed.employees.packer.id,
          date: new Date('2026-04-10'),
          amount: new Prisma.Decimal(2500),
          source: 'SHIFT_DAY',
        },
      ],
    });

    // ОТК видит только свою.
    const list = await request(t.app.getHttpServer())
      .get('/api/salary')
      .set('Cookie', cookies.qc);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].employeeId).toBe(seed.employees.qc.id);

    // Через employeeId чужого тоже не вытащит.
    const probe = await request(t.app.getHttpServer())
      .get('/api/salary')
      .query({ employeeId: seed.employees.packer.id })
      .set('Cookie', cookies.qc);
    expect(probe.status).toBe(200);
    expect(probe.body.total).toBe(1);
    expect(probe.body.items[0].employeeId).toBe(seed.employees.qc.id);
  });

  test('обычный сотрудник не может PATCH /api/salary/:id', async () => {
    const entry = await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: new Date('2026-04-10'),
        amount: new Prisma.Decimal(3000),
        source: 'SHIFT_DAY',
      },
    });
    const res = await request(t.app.getHttpServer())
      .patch(`/api/salary/${entry.id}`)
      .set('Cookie', cookies.qc)
      .send({ amount: 1 });
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 8. RBAC: employees endpoint
  // -------------------------------------------------------------------------

  test('GET /api/employees доступен только SHOP_MANAGER/ADMIN', async () => {
    const ok = await request(t.app.getHttpServer())
      .get('/api/employees')
      .set('Cookie', cookies.manager);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
    expect(ok.body.length).toBeGreaterThanOrEqual(1);

    const forbidden = await request(t.app.getHttpServer())
      .get('/api/employees')
      .set('Cookie', cookies.seamstress);
    expect(forbidden.status).toBe(403);
  });

  test('PATCH /api/employees/:id меняет compensationType + salaryPerShift', async () => {
    const res = await request(t.app.getHttpServer())
      .patch(`/api/employees/${seed.employees.cutter.id}`)
      .set('Cookie', cookies.manager)
      .send({ compensationType: 'SALARY', salaryPerShift: 4200 });
    expect(res.status).toBe(200);
    expect(res.body.compensationType).toBe('SALARY');
    expect(res.body.salaryPerShift).toBeCloseTo(4200, 2);
  });

  test('PATCH /api/employees/:id запрещает SALARY без ставки', async () => {
    const res = await request(t.app.getHttpServer())
      .patch(`/api/employees/${seed.employees.cutter.id}`)
      .set('Cookie', cookies.manager)
      .send({ compensationType: 'SALARY', salaryPerShift: null });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EMPLOYEE_SALARY_RATE_REQUIRED');
  });

  // -------------------------------------------------------------------------
  // 9. RESET: вернуть запись под автоматику
  // -------------------------------------------------------------------------

  test('PATCH с reset=true сбрасывает editedManually и пересчитывает amount по ставке', async () => {
    const entry = await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: new Date('2026-04-12'),
        amount: new Prisma.Decimal(9999),
        source: 'SHIFT_DAY',
        editedManually: true,
        managerComment: 'Что-то странное',
      },
    });
    const res = await request(t.app.getHttpServer())
      .patch(`/api/salary/${entry.id}`)
      .set('Cookie', cookies.manager)
      .send({ reset: true });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBeCloseTo(3000, 2);
    expect(res.body.editedManually).toBe(false);
    expect(res.body.managerComment).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 10. AUDIT TRAIL (PHASE 2 STEP 4 «audit manual salary edits»)
  // -------------------------------------------------------------------------

  test('PATCH /api/salary/:id пишет SALARY_ENTRY_UPDATED с before/after-снимком', async () => {
    const entry = await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: new Date('2026-04-15'),
        amount: new Prisma.Decimal(3000),
        source: 'SHIFT_DAY',
      },
    });
    const res = await request(t.app.getHttpServer())
      .patch(`/api/salary/${entry.id}`)
      .set('Cookie', cookies.manager)
      .send({ amount: 4500, managerComment: 'Переработка' });
    expect(res.status).toBe(200);

    const auditRows = await t.prisma.auditLog.findMany({
      where: { entityType: 'SALARY_ENTRY', entityId: entry.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(auditRows).toHaveLength(1);
    const log = auditRows[0]!;
    expect(log.event).toBe('SALARY_ENTRY_UPDATED');
    expect(log.employeeId).toBe(seed.employees['shop-chief'].id);
    const payload = log.payload as Record<string, unknown>;
    expect(payload.salaryEntryId).toBe(entry.id);
    expect(payload.employeeId).toBe(seed.employees.qc.id);
    expect(payload.date).toBe('2026-04-15');
    expect(payload.reset).toBe(false);
    expect(payload.editedByEmployeeId).toBe(seed.employees['shop-chief'].id);
    const before = payload.before as Record<string, unknown>;
    const after = payload.after as Record<string, unknown>;
    expect(before.amount).toBeCloseTo(3000, 2);
    expect(before.managerComment).toBeNull();
    expect(before.editedManually).toBe(false);
    expect(after.amount).toBeCloseTo(4500, 2);
    expect(after.managerComment).toBe('Переработка');
    expect(after.editedManually).toBe(true);
  });

  test('PATCH /api/salary/:id с reset=true пишет SALARY_ENTRY_RESET с reset:true', async () => {
    const entry = await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: new Date('2026-04-16'),
        amount: new Prisma.Decimal(7777),
        source: 'SHIFT_DAY',
        editedManually: true,
        managerComment: 'Старая правка',
        editedByEmployeeId: seed.employees['shop-chief'].id,
      },
    });
    const res = await request(t.app.getHttpServer())
      .patch(`/api/salary/${entry.id}`)
      .set('Cookie', cookies.manager)
      .send({ reset: true });
    expect(res.status).toBe(200);

    const auditRows = await t.prisma.auditLog.findMany({
      where: { entityType: 'SALARY_ENTRY', entityId: entry.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(auditRows).toHaveLength(1);
    const log = auditRows[0]!;
    expect(log.event).toBe('SALARY_ENTRY_RESET');
    expect(log.employeeId).toBe(seed.employees['shop-chief'].id);
    const payload = log.payload as Record<string, unknown>;
    expect(payload.reset).toBe(true);
    expect(payload.salaryEntryId).toBe(entry.id);
    expect(payload.employeeId).toBe(seed.employees.qc.id);
    expect(payload.date).toBe('2026-04-16');
    const before = payload.before as Record<string, unknown>;
    const after = payload.after as Record<string, unknown>;
    expect(before.amount).toBeCloseTo(7777, 2);
    expect(before.managerComment).toBe('Старая правка');
    expect(before.editedManually).toBe(true);
    expect(after.amount).toBeCloseTo(3000, 2);
    expect(after.managerComment).toBeNull();
    expect(after.editedManually).toBe(false);
  });

  test('автоматический syncDailySalary не пишет SALARY_ENTRY_* в AuditLog', async () => {
    // Регрессия: только ручной PATCH должен оставлять след в журнале.
    // Иначе на каждый start/stop shift журнал засыпался бы рутиной и
    // потерял ценность для разбора правок (см. JSDoc метода).
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      })
      .expect((r) => {
        if (r.status >= 300) throw new Error(JSON.stringify(r.body));
      });

    const count = await t.prisma.auditLog.count({
      where: { entityType: 'SALARY_ENTRY' },
    });
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function createPassport(t: TestApp, seed: SeedResult) {
  const order = await t.prisma.order.create({
    data: {
      number: `O-SAL-${Date.now()}`,
      orderDate: new Date(),
      color: seed.product.color,
      status: 'IN_PRODUCTION',
      items: {
        create: {
          productId: seed.product.id,
          sizeId: seed.sizes.M,
          qtyPlan: 5,
        },
      },
    },
  });
  return t.prisma.passport.create({
    data: {
      number: `P-SAL-${Date.now()}`,
      orderId: order.id,
      productId: seed.product.id,
      sizeId: seed.sizes.M,
      color: seed.product.color,
      rollNumber: 'R-SAL',
      cutDate: new Date(),
      qtyPlan: 5,
      qtyCut: 5,
      qtyGood: 5,
      qrCode: `passport:sal-${Date.now()}`,
      cutterId: seed.employees.cutter.id,
      creatorId: seed.employees.cutter.id,
    },
  });
}
