/**
 * Integration-тест RBAC видимости начислений.
 *
 * Покрывает требования по разграничению доступа на чтение
 * `OperationEntry` (см. `docs/api.md §10`):
 *
 *   1. SHOP_MANAGER видит все строки и любые статусы.
 *   2. Обычный сотрудник (PIECEWORK или SALARY) видит только свой
 *      `employeeId` и только `APPROVED`. Любая попытка поднять чужие
 *      строки или pending через query режется на сервере.
 *   3. На `/api/passports/:id/earnings` обычный сотрудник видит только
 *      свои подтверждённые начисления; если их нет — пустой массив,
 *      даже если у других сотрудников по этому паспорту есть строки.
 *   4. Summary не отдаёт обычному сотруднику чужой totalApproved
 *      и не показывает totalPending.
 *
 * Полный путь «order → passport → scan → packing» уже покрыт
 * `production-flow.test.ts`. Здесь мы строим нужное состояние через
 * Prisma напрямую, чтобы тест бил именно по слою чтения и не зависел
 * от семантики piecework-операций / тарифов.
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

describeWithDb('integration — earnings RBAC visibility', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let passportId: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    // resetDatabase сносит и системного admin, выпущенного в startTestApp.
    // Восстанавливаем явно — без него adminCookie развалится на 401
    // (`AuthGuard.resolvePrincipal` тянет Employee из БД).
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
      manager: loginAs(t, seed.employees['shop-chief']),
      cutter: loginAs(t, seed.employees['cutter']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      admin: loginAs(t, {
        id: admin.id,
        role: admin.role,
        login: admin.login,
        fullName: admin.fullName,
      }),
    };

    // Минимальное состояние: один паспорт + три начисления:
    //   - APPROVED  для cutter (раскройщик),
    //   - APPROVED  для seamstress (пошив, уже после упаковки),
    //   - PENDING_RELEASE для seamstress (пошив, ещё не упакован).
    const order = await t.prisma.order.create({
      data: {
        number: 'O-RBAC-1',
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
    const passport = await t.prisma.passport.create({
      data: {
        number: 'P-RBAC-1',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: 'R-RBAC',
        cutDate: new Date(),
        qtyPlan: 5,
        qtyCut: 5,
        qtyGood: 5,
        qrCode: `passport:rbac-${Date.now()}`,
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
          approvedAt: new Date(),
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
          approvedAt: new Date(),
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
        },
      ],
    });
  });

  // -------------------------------------------------------------------------
  // 1. MANAGER FULL VISIBILITY
  // -------------------------------------------------------------------------

  test('SHOP_MANAGER видит все начисления всех сотрудников и все статусы', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/earnings')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const employeeIds = new Set(
      (res.body.items as Array<{ employeeId: string }>).map((i) => i.employeeId),
    );
    expect(employeeIds.has(seed.employees.cutter.id)).toBe(true);
    expect(employeeIds.has(seed.employees.seamstress.id)).toBe(true);
    const statuses = new Set(
      (res.body.items as Array<{ status: string }>).map((i) => i.status),
    );
    expect(statuses.has('APPROVED')).toBe(true);
    expect(statuses.has('PENDING_RELEASE')).toBe(true);
  });

  test('ADMIN видит все начисления как и SHOP_MANAGER', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/earnings')
      .set('Cookie', cookies.admin);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  test('SHOP_MANAGER summary считает APPROVED и PENDING отдельно', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/earnings/summary')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.countApproved).toBe(2);
    expect(res.body.countPending).toBe(1);
    expect(res.body.totalApproved).toBeCloseTo(100, 2);
    expect(res.body.totalPending).toBeCloseTo(50, 2);
  });

  // -------------------------------------------------------------------------
  // 2. NON-MANAGER OWN-CONFIRMED-ONLY
  // -------------------------------------------------------------------------

  test('обычный сотрудник видит только свои APPROVED начисления', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/earnings')
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const items = res.body.items as Array<{
      employeeId: string;
      status: string;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0].employeeId).toBe(seed.employees.seamstress.id);
    expect(items[0].status).toBe('APPROVED');
  });

  test('обычный сотрудник не может через employeeId увидеть чужие', async () => {
    // Швея пытается выдать себя за раскройщика — backend всё равно
    // вернёт только её собственные APPROVED строки.
    const res = await request(t.app.getHttpServer())
      .get('/api/earnings')
      .query({ employeeId: seed.employees.cutter.id })
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const items = res.body.items as Array<{ employeeId: string }>;
    expect(items.every((i) => i.employeeId === seed.employees.seamstress.id))
      .toBe(true);
  });

  test('обычный сотрудник не может увидеть свои PENDING через ?status=', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/earnings')
      .query({ status: 'PENDING_RELEASE' })
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(200);
    // PENDING строка у швеи существует, но скоуп режет её.
    expect(res.body.total).toBe(1);
    const items = res.body.items as Array<{ status: string }>;
    expect(items.every((i) => i.status === 'APPROVED')).toBe(true);
  });

  test('обычный сотрудник без своих начислений получает пустой ответ', async () => {
    // У ОТК (роль QC, оклад) собственных начислений нет.
    const res = await request(t.app.getHttpServer())
      .get('/api/earnings')
      .set('Cookie', cookies.qc);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });

  test('summary обычного сотрудника не отдаёт totalPending и считает только свои APPROVED', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/earnings/summary')
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(200);
    expect(res.body.countApproved).toBe(1);
    expect(res.body.countPending).toBe(0);
    expect(res.body.totalApproved).toBeCloseTo(50, 2);
    expect(res.body.totalPending).toBe(0);
  });

  test('summary обычного сотрудника игнорирует чужой employeeId в query', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/earnings/summary')
      .query({ employeeId: seed.employees.cutter.id })
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(200);
    expect(res.body.totalApproved).toBeCloseTo(50, 2);
    expect(res.body.totalPending).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. /api/passports/:id/earnings
  // -------------------------------------------------------------------------

  test('GET /api/passports/:id/earnings: SHOP_MANAGER видит все три строки', async () => {
    const res = await request(t.app.getHttpServer())
      .get(`/api/passports/${passportId}/earnings`)
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });

  test('GET /api/passports/:id/earnings: швея видит только свою APPROVED строку', async () => {
    const res = await request(t.app.getHttpServer())
      .get(`/api/passports/${passportId}/earnings`)
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].employeeId).toBe(seed.employees.seamstress.id);
    expect(res.body[0].status).toBe('APPROVED');
  });

  test('GET /api/passports/:id/earnings: ОТК (без начислений) получает пустой массив, а не чужие строки', async () => {
    const res = await request(t.app.getHttpServer())
      .get(`/api/passports/${passportId}/earnings`)
      .set('Cookie', cookies.qc);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
