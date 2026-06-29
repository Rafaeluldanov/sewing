/**
 * Integration-тест создания сотрудников через `POST /api/employees`
 * (см. `docs/api.md §3b`, `docs/screens.md §10d`, ADR-0021 + post-задача
 * «Добавить сотрудника» с UI на `/admin/employees/new`).
 *
 * Сценарии:
 *   1. Happy-path: ADMIN/SHOP_MANAGER создают карточку → ответ
 *      содержит EmployeeDetailDto без pinHash, в БД лежит bcrypt-hash,
 *      под этим логином сразу можно залогиниться (`POST /api/auth/login`).
 *   2. Окладной инвариант: для `SALARY`/`MIXED` обязательна положительная
 *      `salaryPerShift` (Zod 400 → VALIDATION_ERROR; и
 *      EMPLOYEE_SALARY_RATE_REQUIRED как сервисный fallback).
 *   3. Уникальность login: повторный POST → 409
 *      `EMPLOYEE_LOGIN_TAKEN`, существующий сотрудник остаётся живым.
 *   4. RBAC: рабочие роли (SEAMSTRESS/QC/CUTTER) → 403, чтение списка
 *      под чужим логином не открывается.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — employees create (POST /api/employees)', () => {
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

    const adminPin = await bcrypt.hash('rbac-admin', 4);
    const admin = await t.prisma.employee.upsert({
      where: { login: 'rbac-admin' },
      create: {
        login: 'rbac-admin',
        fullName: 'RBAC Admin',
        role: 'ADMIN',
        active: true,
        pinHash: adminPin,
      },
      update: { active: true, role: 'ADMIN', fullName: 'RBAC Admin' },
    });

    cookies = {
      admin: loginAs(t, {
        id: admin.id,
        login: admin.login,
        role: admin.role,
        fullName: admin.fullName,
      }),
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      cutter: loginAs(t, seed.employees['cutter']),
    };
  });

  // ---------------------------------------------------------------------------
  // 1. Happy-path
  // ---------------------------------------------------------------------------

  test('SHOP_MANAGER создаёт PIECEWORK-сотрудника без ставки за смену', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Иванова Анна Петровна',
        login: 'ivanova',
        pin: 'pin-1234',
        role: 'SEAMSTRESS',
        compensationType: 'PIECEWORK',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      fullName: 'Иванова Анна Петровна',
      login: 'ivanova',
      role: 'SEAMSTRESS',
      compensationType: 'PIECEWORK',
      salaryPerShift: null,
      active: true,
    });
    // pinHash наружу никогда не отдаётся — это инвариант EmployeeDetailDto.
    expect(res.body.pinHash).toBeUndefined();
    expect(res.body.password).toBeUndefined();
    expect(res.body.pin).toBeUndefined();

    // В БД pinHash действительно bcrypt-формы, не plain text.
    const inDb = await t.prisma.employee.findUnique({
      where: { login: 'ivanova' },
    });
    expect(inDb).not.toBeNull();
    expect(inDb!.pinHash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare('pin-1234', inDb!.pinHash)).toBe(true);

    // И самый важный happy-path side-check: новый сотрудник умеет
    // логиниться через тот же `AuthService.login`, что и seed-аккаунты
    // (контроллер ожидает `{ login, password }` и отдаёт 200).
    const login = await request(t.app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: 'ivanova', password: 'pin-1234' });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({
      user: { login: 'ivanova', role: 'SEAMSTRESS' },
    });
  });

  test('SHOP_MANAGER создаёт SALARY-сотрудника с почасовой ставкой', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Сидоров Иван Иванович',
        login: 'sidorov',
        pin: 'pin-9876',
        role: 'QC',
        compensationType: 'SALARY',
        salaryPerHour: '1500.50',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      login: 'sidorov',
      role: 'QC',
      compensationType: 'SALARY',
      salaryPerHour: 1500.5,
    });
  });

  test('login нормализуется в lower-case', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Test Mixed Case',
        login: 'MixedCaseUser',
        pin: 'pin-1234',
        role: 'SEAMSTRESS',
        compensationType: 'PIECEWORK',
      });
    expect(res.status).toBe(201);
    expect(res.body.login).toBe('mixedcaseuser');
  });

  // ---------------------------------------------------------------------------
  // 2. Окладной инвариант
  // ---------------------------------------------------------------------------

  test('SALARY без salaryPerHour → 400 VALIDATION_ERROR (Zod superRefine)', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'No Rate Salary',
        login: 'norate',
        pin: 'pin-1234',
        role: 'IRONING',
        compensationType: 'SALARY',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');

    // И в БД ничего не появилось.
    const inDb = await t.prisma.employee.findUnique({ where: { login: 'norate' } });
    expect(inDb).toBeNull();
  });

  test('MIXED с нулевой salaryPerHour → 400 (zero не считается positive)', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Zero Rate Mixed',
        login: 'zerorate',
        pin: 'pin-1234',
        role: 'SEAMSTRESS',
        compensationType: 'MIXED',
        salaryPerHour: 0,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // ---------------------------------------------------------------------------
  // 3. Уникальность login
  // ---------------------------------------------------------------------------

  test('повторный login → 409 EMPLOYEE_LOGIN_TAKEN, существующая карточка не пострадала', async () => {
    const ok = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'First Holder',
        login: 'duplicate',
        pin: 'pin-1234',
        role: 'PACKING',
        compensationType: 'PIECEWORK',
      });
    expect(ok.status).toBe(201);
    const firstId = ok.body.id as string;

    // Второй POST с тем же login (включая lower-case нормализацию).
    const dup = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Duplicate Holder',
        login: 'DUPLICATE',
        pin: 'pin-9999',
        role: 'PACKING',
        compensationType: 'PIECEWORK',
      });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('EMPLOYEE_LOGIN_TAKEN');

    // Первый сотрудник по-прежнему живой и его pinHash не менялся.
    const stillFirst = await t.prisma.employee.findUnique({ where: { id: firstId } });
    expect(stillFirst).not.toBeNull();
    expect(await bcrypt.compare('pin-1234', stillFirst!.pinHash)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 4. RBAC
  // ---------------------------------------------------------------------------

  test('RBAC: SEAMSTRESS / QC / CUTTER — 403 на POST /api/employees', async () => {
    for (const who of ['seamstress', 'qc', 'cutter'] as const) {
      const res = await request(t.app.getHttpServer())
        .post('/api/employees')
        .set('Cookie', cookies[who])
        .send({
          fullName: `Hack ${who}`,
          login: `evil-${who}`,
          pin: 'pin-1234',
          role: 'ADMIN',
          compensationType: 'PIECEWORK',
        });
      expect(res.status, `role=${who}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }

    const total = await t.prisma.employee.count({
      where: { login: { startsWith: 'evil-' } },
    });
    expect(total).toBe(0);
  });

  test('RBAC: ADMIN тоже умеет создать сотрудника (паритет с SHOP_MANAGER)', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.admin)
      .send({
        fullName: 'Admin Created',
        login: 'admin-made',
        pin: 'pin-1234',
        role: 'CUTTER_ASSISTANT',
        compensationType: 'PIECEWORK',
      });
    expect(res.status).toBe(201);
    expect(res.body.login).toBe('admin-made');
  });

  // ---------------------------------------------------------------------------
  // 5. PHASE 2 STEP 2 — Employee.companyDivisionId
  // ---------------------------------------------------------------------------

  test('PHASE 2 STEP 2: создание сотрудника с companyDivisionId привязывает карточку', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Marketplace Worker',
        login: 'mp-worker',
        pin: 'pin-1234',
        role: 'SEAMSTRESS',
        compensationType: 'PIECEWORK',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
      });
    expect(res.status).toBe(201);
    expect(res.body.companyDivisionId).toBe(
      seed.companyDivisions.MARKETPLACE.id,
    );
    expect(res.body.companyDivision).toMatchObject({
      id: seed.companyDivisions.MARKETPLACE.id,
      code: 'MARKETPLACE',
    });

    const inDb = await t.prisma.employee.findUnique({
      where: { login: 'mp-worker' },
    });
    expect(inDb!.companyDivisionId).toBe(seed.companyDivisions.MARKETPLACE.id);
  });

  test('PHASE 2 STEP 2: создание без companyDivisionId оставляет null', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'No Division Worker',
        login: 'nodiv',
        pin: 'pin-1234',
        role: 'SEAMSTRESS',
        compensationType: 'PIECEWORK',
      });
    expect(res.status).toBe(201);
    expect(res.body.companyDivisionId).toBeNull();
    expect(res.body.companyDivision).toBeNull();
  });

  test('PHASE 2 STEP 2: PATCH companyDivisionId перепривязывает сотрудника', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Mover',
        login: 'mover',
        pin: 'pin-1234',
        role: 'SEAMSTRESS',
        compensationType: 'PIECEWORK',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
      });
    expect(created.status).toBe(201);

    const patched = await request(t.app.getHttpServer())
      .patch(`/api/employees/${created.body.id}`)
      .set('Cookie', cookies.manager)
      .send({ companyDivisionId: seed.companyDivisions.OTHER.id });
    expect(patched.status).toBe(200);
    expect(patched.body.companyDivisionId).toBe(
      seed.companyDivisions.OTHER.id,
    );

    const cleared = await request(t.app.getHttpServer())
      .patch(`/api/employees/${created.body.id}`)
      .set('Cookie', cookies.manager)
      .send({ companyDivisionId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.companyDivisionId).toBeNull();
    expect(cleared.body.companyDivision).toBeNull();
  });

  test('PHASE 2 STEP 2: companyDivisionId с несуществующим id → 404 COMPANY_DIVISION_NOT_FOUND', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Ghost Division',
        login: 'ghost-div',
        pin: 'pin-1234',
        role: 'SEAMSTRESS',
        compensationType: 'PIECEWORK',
        companyDivisionId: 'does-not-exist',
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('COMPANY_DIVISION_NOT_FOUND');
  });

  test('PHASE 2 STEP 2: companyDivisionId на soft-deleted подразделение → 409 COMPANY_DIVISION_INACTIVE', async () => {
    await t.prisma.companyDivision.update({
      where: { id: seed.companyDivisions.OTHER.id },
      data: { isActive: false },
    });
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Inactive Division',
        login: 'inactive-div',
        pin: 'pin-1234',
        role: 'SEAMSTRESS',
        compensationType: 'PIECEWORK',
        companyDivisionId: seed.companyDivisions.OTHER.id,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COMPANY_DIVISION_INACTIVE');
  });

  test('PHASE 2 STEP 2: GET /api/employees?companyDivisionId фильтрует список', async () => {
    await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Marketplace Only',
        login: 'mp-only',
        pin: 'pin-1234',
        role: 'SEAMSTRESS',
        compensationType: 'PIECEWORK',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
      });
    await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Other Only',
        login: 'other-only',
        pin: 'pin-1234',
        role: 'SEAMSTRESS',
        compensationType: 'PIECEWORK',
        companyDivisionId: seed.companyDivisions.OTHER.id,
      });

    const list = await request(t.app.getHttpServer())
      .get('/api/employees')
      .query({ companyDivisionId: seed.companyDivisions.MARKETPLACE.id })
      .set('Cookie', cookies.manager);
    expect(list.status).toBe(200);
    const logins = (list.body as Array<{ login: string }>).map((e) => e.login);
    expect(logins).toContain('mp-only');
    expect(logins).not.toContain('other-only');
  });
});
