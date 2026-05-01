/**
 * Integration-тесты модуля «Себестоимость выпуска» (`/api/costs/production`).
 *
 * Контракт `docs/api.md §17`, бизнес-правила `docs/domain.md §17`,
 * экран `docs/screens.md §17`. Read-only, доступно только
 * `SHOP_MANAGER` и `ADMIN` (см. `apps/api/.../costs.controller.ts`).
 *
 * Покрытие:
 *   1. Базовая агрегация: упакованный паспорт даёт producedUnits +
 *      pieceworkCost + (распределённая) salaryCost.
 *   2. Длительности стадий QC/WTO выводятся по `PassportEvent`
 *      (`OPERATION_SCAN` → `QC_PASSED`/`WTO_PASSED`) и cap-аются
 *      `MAX_STAGE_MINUTES_PER_PASSPORT = 60`.
 *   3. Простой = `SHIFT_MINUTES − Σ trackedMinutes` для окладного
 *      сотрудника, у которого есть `SalaryEntry` за этот день. Простой
 *      НЕ распределяется на изделия (totalCost к нему не прибавляется).
 *   4. RBAC: SHOP_MANAGER/ADMIN — 200; остальные — 403; без сессии — 401.
 *   5. Период: dateFrom/dateTo фильтруют выборку, ответ всегда содержит
 *      все дни диапазона (даже пустые), чтобы график не рвался.
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

describeWithDb('integration — production cost (Себестоимость выпуска)', () => {
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

    // ОТК / ВТО / упаковка — на оклад с понятной ставкой:
    // 480 ₽/смена → 1 ₽/мин. Это упрощает арифметику тестов.
    await t.prisma.employee.update({
      where: { id: seed.employees.qc.id },
      data: {
        compensationType: 'SALARY',
        salaryPerShift: new Prisma.Decimal(480),
      },
    });
    await t.prisma.employee.update({
      where: { id: seed.employees.ironing.id },
      data: {
        compensationType: 'SALARY',
        salaryPerShift: new Prisma.Decimal(480),
      },
    });
    await t.prisma.employee.update({
      where: { id: seed.employees.packer.id },
      data: {
        compensationType: 'SALARY',
        salaryPerShift: new Prisma.Decimal(480),
      },
    });
  });

  // -------------------------------------------------------------------------
  // 1. Базовая агрегация
  // -------------------------------------------------------------------------

  test('1. Один упакованный паспорт: producedUnits + piecework + salaryShare', async () => {
    const day = utcDay('2026-04-10');
    const passport = await createPlacedPassport(t, seed, 5, day);

    // Сдельщина швеи: 5 шт × 10 ₽ = 50 ₽, статус APPROVED.
    await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 5,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(50),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: day,
      },
    });

    // QC stage: scan → 5 минут → QC_PASSED. Длительность = 5 мин.
    const qcAccept = at(day, 9, 0);
    const qcDone = at(day, 9, 5);
    await writeScan(t, passport.id, seed.operations.QC.id, seed.employees.qc.id, qcAccept);
    await writeStageDone(t, passport.id, 'QC_PASSED', seed.employees.qc.id, qcDone);

    // WTO stage: scan → 3 минуты → WTO_PASSED. Длительность = 3 мин.
    const wtoAccept = at(day, 10, 0);
    const wtoDone = at(day, 10, 3);
    await writeScan(t, passport.id, seed.operations.IRONING.id, seed.employees.ironing.id, wtoAccept);
    await writeStageDone(t, passport.id, 'WTO_PASSED', seed.employees.ironing.id, wtoDone);

    // PACKING: только PACKED, accept фолбек = current − 1 мин = 1 мин.
    const packedAt = at(day, 11, 0);
    await writePacked(t, passport.id, seed.employees.packer.id, packedAt, 5);

    // SalaryEntry создаём явно — мы не пускаем shifts/start, всё пишется
    // напрямую под admin-ом.
    await createSalary(t, seed.employees.qc.id, day, 480);
    await createSalary(t, seed.employees.ironing.id, day, 480);
    await createSalary(t, seed.employees.packer.id, day, 480);

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-10', dateTo: '2026-04-10' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.dateFrom).toBe('2026-04-10');
    expect(body.dateTo).toBe('2026-04-10');
    expect(body.days).toHaveLength(1);
    const d = body.days[0];
    expect(d.date).toBe('2026-04-10');
    expect(d.producedUnits).toBe(5);
    // 1 ₽/мин × (5 + 3 + 1) мин = 9 ₽ окладной доли.
    expect(d.salaryCost).toBeCloseTo(9, 2);
    expect(d.pieceworkCost).toBeCloseTo(50, 2);
    expect(d.totalCost).toBeCloseTo(59, 2);
    expect(d.trackedMinutes).toBe(9);
    // Простой = 3 окладника × 480 мин − 9 мин tracked = 1431 мин.
    expect(d.idleMinutes).toBe(3 * 480 - 9);
    // 1 ₽/мин × 1431 мин = 1431 ₽.
    expect(d.idleCost).toBeCloseTo(1431, 2);

    expect(body.summary.producedUnits).toBe(5);
    expect(body.summary.totalCost).toBeCloseTo(59, 2);
    expect(body.summary.avgCostPerUnit).toBeCloseTo(59 / 5, 2);
    expect(body.summary.idleCost).toBeCloseTo(1431, 2);
  });

  // -------------------------------------------------------------------------
  // 2. Cap длительности
  // -------------------------------------------------------------------------

  test('2. Аномально долгая стадия cap-ается MAX_STAGE_MINUTES_PER_PASSPORT (60)', async () => {
    const day = utcDay('2026-04-11');
    const passport = await createPlacedPassport(t, seed, 1, day);

    // QC scan → +180 минут (3 часа) → QC_PASSED. Сырая длительность 180,
    // но cap 60 → ровно 60 минут.
    const qcAccept = at(day, 9, 0);
    const qcDone = at(day, 12, 0);
    await writeScan(t, passport.id, seed.operations.QC.id, seed.employees.qc.id, qcAccept);
    await writeStageDone(t, passport.id, 'QC_PASSED', seed.employees.qc.id, qcDone);

    await createSalary(t, seed.employees.qc.id, day, 480);

    // Для агрегации даты PACKED тоже нужен — иначе producedUnits=0,
    // но trackedMinutes/idle всё равно посчитаются.
    const packedAt = at(day, 13, 0);
    await writePacked(t, passport.id, seed.employees.packer.id, packedAt, 1);

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-11', dateTo: '2026-04-11' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const d = res.body.days[0];
    // QC внёс 60 мин (cap). PACKING fallback +1 мин. tracked = 61.
    expect(d.trackedMinutes).toBe(61);
    // QC: 60 мин (cap) × 1 ₽/мин + PACKING fallback: 1 мин × 1 ₽/мин = 61.
    expect(d.salaryCost).toBeCloseTo(61, 2);
  });

  // -------------------------------------------------------------------------
  // 3. Простой не распределяется на изделия
  // -------------------------------------------------------------------------

  test('3. Окладной сотрудник без tracked-минут даёт чистый простой', async () => {
    const day = utcDay('2026-04-12');
    await createSalary(t, seed.employees.qc.id, day, 480);

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-12', dateTo: '2026-04-12' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const d = res.body.days[0];
    expect(d.producedUnits).toBe(0);
    expect(d.totalCost).toBe(0);
    expect(d.salaryCost).toBe(0);
    expect(d.pieceworkCost).toBe(0);
    // Простой = 480 мин × 1 ₽/мин = 480 ₽.
    expect(d.idleMinutes).toBe(480);
    expect(d.idleCost).toBeCloseTo(480, 2);
  });

  // -------------------------------------------------------------------------
  // 4. RBAC
  // -------------------------------------------------------------------------

  test('4a. SHOP_MANAGER → 200, ADMIN → 200', async () => {
    const r1 = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .set('Cookie', cookies.manager);
    expect(r1.status).toBe(200);
    const r2 = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .set('Cookie', cookies.admin);
    expect(r2.status).toBe(200);
  });

  test('4b. SEAMSTRESS / QC / IRONING / PACKING → 403', async () => {
    for (const role of ['seamstress', 'qc', 'ironing', 'packer'] as const) {
      const r = await request(t.app.getHttpServer())
        .get('/api/costs/production')
        .set('Cookie', cookies[role]);
      expect(r.status).toBe(403);
    }
  });

  test('4c. Без сессии → 401', async () => {
    const r = await request(t.app.getHttpServer()).get('/api/costs/production');
    expect(r.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // 5. Диапазон дат: пустые дни тоже включены
  // -------------------------------------------------------------------------

  test('5. Период [from..to] всегда возвращает все календарные дни', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-01', dateTo: '2026-04-05' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(5);
    const dates = res.body.days.map((d: { date: string }) => d.date);
    expect(dates).toEqual([
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      '2026-04-04',
      '2026-04-05',
    ]);
    for (const d of res.body.days) {
      expect(d.producedUnits).toBe(0);
      expect(d.totalCost).toBe(0);
      expect(d.idleCost).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // 6. Несколько паспортов в один день агрегируются
  // -------------------------------------------------------------------------

  test('6. Два паспорта в один день: producedUnits и totalCost суммируются', async () => {
    const day = utcDay('2026-04-13');
    const p1 = await createPlacedPassport(t, seed, 3, day);
    const p2 = await createPlacedPassport(t, seed, 2, day);

    for (const p of [p1, p2]) {
      await t.prisma.operationEntry.create({
        data: {
          passportId: p.id,
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          employeeId: seed.employees.seamstress.id,
          qty: p.qtyGood,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(p.qtyGood * 10),
          status: 'APPROVED',
          approvalMode: 'IMMEDIATE',
          sourceEventType: 'PASSPORT_CREATED',
          approvedAt: day,
        },
      });
    }
    await writePacked(t, p1.id, seed.employees.packer.id, at(day, 11, 0), p1.qtyGood);
    await writePacked(t, p2.id, seed.employees.packer.id, at(day, 11, 5), p2.qtyGood);

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-13', dateTo: '2026-04-13' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const d = res.body.days[0];
    expect(d.producedUnits).toBe(5);
    expect(d.pieceworkCost).toBeCloseTo(50, 2);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function utcDay(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function at(day: Date, hour: number, minute: number): Date {
  const d = new Date(day);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

async function createPlacedPassport(
  t: TestApp,
  seed: SeedResult,
  qty: number,
  cutDate: Date,
): Promise<{ id: string; qtyGood: number }> {
  const order = await t.prisma.order.create({
    data: {
      number: `O-PC-${randomSuffix()}`,
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
      number: `P-PC-${randomSuffix()}`,
      orderId: order.id,
      productId: seed.product.id,
      sizeId: seed.sizes.M,
      color: seed.product.color,
      rollNumber: 'R-PC',
      cutDate,
      qtyPlan: qty,
      qtyCut: qty,
      qtyGood: qty,
      qrCode: `passport:pc-${randomSuffix()}`,
      cutterId: seed.employees.cutter.id,
      creatorId: seed.employees.cutter.id,
      status: 'IN_PROGRESS',
    },
  });
  return { id: p.id, qtyGood: qty };
}

async function writeScan(
  t: TestApp,
  passportId: string,
  operationId: string,
  employeeId: string,
  at: Date,
): Promise<void> {
  await t.prisma.passportEvent.create({
    data: {
      passportId,
      type: 'OPERATION_SCAN',
      operationId,
      employeeId,
      qty: 1,
      createdAt: at,
    },
  });
}

async function writeStageDone(
  t: TestApp,
  passportId: string,
  type: 'QC_PASSED' | 'WTO_PASSED',
  employeeId: string,
  at: Date,
): Promise<void> {
  await t.prisma.passportEvent.create({
    data: {
      passportId,
      type,
      employeeId,
      createdAt: at,
    },
  });
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
