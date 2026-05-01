/**
 * Integration-тесты «Дашборд начальника производства»
 * (`GET /api/dashboard/production`).
 *
 * Контракт `docs/api.md §11b`, экран `docs/screens.md §18`. Read-only,
 * доступно только `SHOP_MANAGER` и `ADMIN`
 * (см. `apps/api/src/modules/dashboard/dashboard.controller.ts`).
 *
 * Покрытие:
 *   1. RBAC — менеджер/админ → 200, рабочие роли → 403, без сессии → 401.
 *   2. Базовая агрегация: один упакованный паспорт в день «сегодня»
 *      даёт producedToday + producedPeriod + KPI.totalCostPeriod.
 *   3. Pipeline — паспорт со «свежим» CUT-статусом видно в стадии CUT,
 *      bottleneck указывает на эту же стадию.
 *   4. Role load — окладной ОТК с SalaryEntry за день, без tracked-минут,
 *      даёт строку с paid=480, idle=480.
 *   5. Period: `days=14` возвращает ровно 14 точек в trend, последняя =
 *      сегодня.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — production dashboard (Дашборд начальника)', () => {
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
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      ironing: loginAs(t, seed.employees['ironing']),
      packer: loginAs(t, seed.employees['packer']),
      admin: t.adminCookie,
    };

    // Унифицируем оплату ОТК/ВТО/Упаковки: 480 ₽/смена → 1 ₽/мин.
    for (const role of ['qc', 'ironing', 'packer'] as const) {
      await t.prisma.employee.update({
        where: { id: seed.employees[role].id },
        data: {
          compensationType: 'SALARY',
          salaryPerShift: new Prisma.Decimal(480),
        },
      });
    }
  });

  // -------------------------------------------------------------------------
  // 1. RBAC
  // -------------------------------------------------------------------------

  test('1a. SHOP_MANAGER → 200, ADMIN → 200', async () => {
    const r1 = await request(t.app.getHttpServer())
      .get('/api/dashboard/production')
      .set('Cookie', cookies.manager);
    expect(r1.status).toBe(200);
    expect(r1.body.kpi).toBeDefined();
    expect(r1.body.pipeline).toBeDefined();
    expect(r1.body.trend).toBeDefined();
    expect(r1.body.roleLoad).toBeDefined();
    expect(r1.body.alerts).toBeDefined();

    const r2 = await request(t.app.getHttpServer())
      .get('/api/dashboard/production')
      .set('Cookie', cookies.admin);
    expect(r2.status).toBe(200);
  });

  test('1b. SEAMSTRESS / QC / IRONING / PACKING → 403', async () => {
    for (const role of ['seamstress', 'qc', 'ironing', 'packer'] as const) {
      const r = await request(t.app.getHttpServer())
        .get('/api/dashboard/production')
        .set('Cookie', cookies[role]);
      expect(r.status).toBe(403);
    }
  });

  test('1c. Без сессии → 401', async () => {
    const r = await request(t.app.getHttpServer()).get(
      '/api/dashboard/production',
    );
    expect(r.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // 2. Базовый KPI: упакованный паспорт сегодня
  // -------------------------------------------------------------------------

  test('2. Упакованный сегодня паспорт — producedToday=qtyGood, totalCostPeriod>0', async () => {
    const today = startOfUtcToday();
    const passport = await createPlacedPassport(t, seed, 4, today);

    // Сдельщина — 4 шт × 10 ₽ = 40 ₽.
    await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 4,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(40),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: today,
      },
    });

    // PACKED today.
    await writePacked(t, passport.id, seed.employees.packer.id, addMinutes(today, 600), 4);

    // Один упаковщик на смене.
    await createSalary(t, seed.employees.packer.id, today, 480);

    const res = await request(t.app.getHttpServer())
      .get('/api/dashboard/production?days=7')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.periodDays).toBe(7);
    expect(body.kpi.producedToday).toBe(4);
    expect(body.kpi.producedPeriod).toBe(4);
    expect(body.kpi.totalCostPeriod).toBeGreaterThan(0);
    // avg = totalCost / 4.
    expect(body.kpi.avgCostPerUnitToday).toBeGreaterThan(0);
    // Упаковщик: idle = 480 − 1 (PACKING fallback) = 479 мин × 1 ₽/мин.
    expect(body.kpi.idleCostToday).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 3. Pipeline: живой паспорт CUT светится в стадии и bottleneck
  // -------------------------------------------------------------------------

  test('3. Живой паспорт без событий → стадия CUT и bottleneck=CUT', async () => {
    const today = startOfUtcToday();
    await createPlacedPassport(t, seed, 7, today); // status=IN_PROGRESS

    const res = await request(t.app.getHttpServer())
      .get('/api/dashboard/production')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const cut = res.body.pipeline.stages.find(
      (s: { stage: string; qty: number }) => s.stage === 'CUT',
    );
    expect(cut).toBeDefined();
    expect(cut.qty).toBe(7);
    expect(res.body.pipeline.bottleneckStage).toBe('CUT');
    expect(res.body.pipeline.bottleneckQty).toBe(7);
    expect(res.body.kpi.wipUnits).toBe(7);
    expect(res.body.kpi.wipPassports).toBe(1);
    expect(res.body.kpi.ordersInProduction).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. Role load: окладной ОТК с SalaryEntry → idle 480
  // -------------------------------------------------------------------------

  test('4. ОТК с salary, без tracked-минут → role load idle=480, paid=480', async () => {
    const today = startOfUtcToday();
    await createSalary(t, seed.employees.qc.id, today, 480);

    const res = await request(t.app.getHttpServer())
      .get('/api/dashboard/production')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const qc = res.body.roleLoad.find(
      (r: { role: string }) => r.role === 'QC',
    );
    expect(qc).toBeDefined();
    expect(qc.employees).toBe(1);
    expect(qc.paidMinutes).toBe(480);
    expect(qc.trackedMinutes).toBe(0);
    expect(qc.idleMinutes).toBe(480);
    expect(qc.idleCost).toBeCloseTo(480, 2);
    expect(qc.utilization).toBe(0);

    // Алерт ROLE_IDLE присутствует и подсвечивает ОТК.
    const alert = res.body.alerts.find(
      (a: { type: string }) => a.type === 'ROLE_IDLE',
    );
    expect(alert).toBeDefined();
    expect(alert.message).toMatch(/ОТК/);
  });

  // -------------------------------------------------------------------------
  // 5. Период
  // -------------------------------------------------------------------------

  test('5. days=14 → trend ровно 14 точек, последняя = today', async () => {
    const todayKey = isoDay(startOfUtcToday());
    const res = await request(t.app.getHttpServer())
      .get('/api/dashboard/production?days=14')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.trend).toHaveLength(14);
    expect(res.body.trend[res.body.trend.length - 1].date).toBe(todayKey);
    expect(res.body.dateTo).toBe(todayKey);
    expect(res.body.today).toBe(todayKey);
  });

  test('5b. неподдерживаемый days=99 → 400 BAD_REQUEST', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/dashboard/production?days=99')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function startOfUtcToday(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function createPlacedPassport(
  t: TestApp,
  seed: SeedResult,
  qty: number,
  cutDate: Date,
): Promise<{ id: string; qtyGood: number }> {
  const order = await t.prisma.order.create({
    data: {
      number: `O-DSH-${randomSuffix()}`,
      orderDate: cutDate,
      color: seed.product.color,
      status: 'IN_PRODUCTION',
      items: {
        create: {
          productId: seed.product.id,
          sizeId: seed.sizes.M,
          qtyPlan: qty,
        },
      },
    },
  });
  const p = await t.prisma.passport.create({
    data: {
      number: `P-DSH-${randomSuffix()}`,
      orderId: order.id,
      productId: seed.product.id,
      sizeId: seed.sizes.M,
      color: seed.product.color,
      rollNumber: 'R-DSH',
      cutDate,
      qtyPlan: qty,
      qtyCut: qty,
      qtyGood: qty,
      qrCode: `passport:dsh-${randomSuffix()}`,
      cutterId: seed.employees.cutter.id,
      creatorId: seed.employees.cutter.id,
      status: 'IN_PROGRESS',
    },
  });
  return { id: p.id, qtyGood: qty };
}

async function writePacked(
  t: TestApp,
  passportId: string,
  employeeId: string,
  at: Date,
  qty: number,
): Promise<void> {
  await t.prisma.passportEvent.create({
    data: {
      passportId,
      type: 'PACKED',
      employeeId,
      qty,
      createdAt: at,
    },
  });
  await t.prisma.passport.update({
    where: { id: passportId },
    data: { status: 'PACKED' },
  });
}

async function createSalary(
  t: TestApp,
  employeeId: string,
  date: Date,
  amount: number,
): Promise<void> {
  await t.prisma.salaryEntry.create({
    data: {
      employeeId,
      date,
      amount: new Prisma.Decimal(amount),
      source: 'SHIFT_DAY',
    },
  });
}

let _suffix = 0;
function randomSuffix(): string {
  _suffix += 1;
  return `${Date.now()}-${_suffix}`;
}
