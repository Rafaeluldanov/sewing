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
 *   2. Окладная доля считается `PassportRealCostService`: реальное время
 *      `ISSUED_TO_EMPLOYEE → OPERATION_FINISHED`, а для терминалов без
 *      accept (ОТК/ВТО/упаковка) — по разрыву между последовательными
 *      завершениями (одиночный терминал = minMs = 1 мин), всё cap-ается
 *      `MAX_STAGE_MINUTES_PER_PASSPORT = 60` и делится между параллельными
 *      паспортами.
 *   3. Простой = `SHIFT_MINUTES − Σ trackedMinutes` для окладного
 *      сотрудника, у которого есть `SalaryEntry` за этот день. Простой
 *      НЕ распределяется на изделия (totalCost к нему не прибавляется).
 *   4. RBAC: SHOP_MANAGER/ADMIN — 200; остальные — 403; без сессии — 401.
 *   5. Период: dateFrom/dateTo фильтруют выборку, ответ всегда содержит
 *      все дни диапазона (даже пустые), чтобы график не рвался.
 *   6. Несколько паспортов в один день агрегируются.
 *   7. Фактическая стоимость материалов (`MaterialIssue.totalCost`)
 *      входит в `materialCost` и `totalCost` периода, если документ
 *      `POSTED` и `passportId` есть в множестве упакованных паспортов
 *      периода. DRAFT, CANCELLED, order-level (без `passportId`) и
 *      POSTED-документы по паспортам вне периода — НЕ попадают.
 *      Несколько POSTED-документов по одному паспорту суммируются;
 *      `materialCost` относится к тому же дню, что и PACKED-event
 *      этого паспорта.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import {
  loginAs,
  refreshAdminCookie,
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
    // Без `refreshAdminCookie` системный admin был бы стёрт TRUNCATE'ом,
    // и `t.adminCookie` ушёл бы в 401.
    await refreshAdminCookie(t);
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      ironing: loginAs(t, seed.employees['ironing']),
      packer: loginAs(t, seed.employees['packer']),
      admin: t.adminCookie,
    };

    // ОТК / ВТО / упаковка — на оклад с понятной ПОЧАСОВОЙ ставкой:
    // 60 ₽/ч → 1 ₽/мин (повременка, computeMinuteRate = ставка/час ÷ 60).
    // Численно эквивалентно прежним 480 ₽/смена / 480 мин. Упрощает
    // арифметику тестов — cost-ассерты ниже не меняются.
    await t.prisma.employee.update({
      where: { id: seed.employees.qc.id },
      data: {
        compensationType: 'SALARY',
        salaryPerHour: new Prisma.Decimal(60),
      },
    });
    await t.prisma.employee.update({
      where: { id: seed.employees.ironing.id },
      data: {
        compensationType: 'SALARY',
        salaryPerHour: new Prisma.Decimal(60),
      },
    });
    await t.prisma.employee.update({
      where: { id: seed.employees.packer.id },
      data: {
        compensationType: 'SALARY',
        salaryPerHour: new Prisma.Decimal(60),
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

    // Новый движок (`PassportRealCostService`) игнорирует `OPERATION_SCAN`
    // (его в реальном флоу нет) и считает время по `ISSUED_TO_EMPLOYEE →
    // OPERATION_FINISHED`, а для терминалов без accept — по разрыву между
    // последовательными завершениями. Здесь у каждого окладника один
    // терминал → minMs = 1 мин.
    // ОТК: единственный QC_PASSED → 1 мин.
    await writeStageDone(t, passport.id, 'QC_PASSED', seed.employees.qc.id, at(day, 9, 5));
    // ВТО: единственный WTO_PASSED → 1 мин.
    await writeStageDone(t, passport.id, 'WTO_PASSED', seed.employees.ironing.id, at(day, 10, 3));
    // Упаковка: единственный PACKED → 1 мин.
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
    // 1 ₽/мин × 1 мин × 3 окладника (ОТК+ВТО+упаковка, каждый = minMs) = 3 ₽.
    expect(d.salaryCost).toBeCloseTo(3, 2);
    expect(d.pieceworkCost).toBeCloseTo(50, 2);
    expect(d.totalCost).toBeCloseTo(53, 2);
    expect(d.trackedMinutes).toBe(3);
    // Простой = 3 окладника × 480 мин − 3 мин tracked = 1437 мин.
    expect(d.idleMinutes).toBe(3 * 480 - 3);
    // 1 ₽/мин × 1437 мин = 1437 ₽.
    expect(d.idleCost).toBeCloseTo(1437, 2);

    expect(body.summary.producedUnits).toBe(5);
    expect(body.summary.totalCost).toBeCloseTo(53, 2);
    expect(body.summary.avgCostPerUnit).toBeCloseTo(53 / 5, 2);
    expect(body.summary.idleCost).toBeCloseTo(1437, 2);
  });

  // -------------------------------------------------------------------------
  // 2. Cap длительности
  // -------------------------------------------------------------------------

  test('2. Аномально долгий разрыв cap-ается MAX_STAGE_MINUTES_PER_PASSPORT (60)', async () => {
    const day = utcDay('2026-04-11');
    const p1 = await createPlacedPassport(t, seed, 1, day);
    const p2 = await createPlacedPassport(t, seed, 1, day);

    // Упаковщик пакует P1 в 09:00 (первый терминал = minMs = 1 мин), затем
    // P2 в 12:00 — разрыв 180 мин, но cap 60 → ровно 60 мин на P2.
    await writePacked(t, p1.id, seed.employees.packer.id, at(day, 9, 0), 1);
    await writePacked(t, p2.id, seed.employees.packer.id, at(day, 12, 0), 1);
    await createSalary(t, seed.employees.packer.id, day, 480);

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-11', dateTo: '2026-04-11' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const d = res.body.days[0];
    // tracked = 1 (P1) + 60 (P2 cap) = 61 мин.
    expect(d.trackedMinutes).toBe(61);
    // (1 + 60) мин × 1 ₽/мин = 61 ₽ (оба паспорта упакованы в этот день).
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

  // -------------------------------------------------------------------------
  // 7. Фактическая стоимость материалов в production cost
  // -------------------------------------------------------------------------
  //
  // Контракт MVP-итерации:
  //   - `materialCost` = Σ `MaterialIssue.totalCost` (POSTED) по
  //     `passportId`, упакованным в этот день;
  //   - DRAFT и CANCELLED не учитываются;
  //   - order-level документы (без `passportId`) сознательно
  //     НЕ включаются в production cost по периоду — без привязки
  //     к паспорту нельзя корректно разнести расход по дню выпуска.
  //   - `materialCost` входит в `totalCost` (наряду с piecework и
  //     salary).

  test('7a. POSTED MaterialIssue с passportId входит в materialCost и totalCost', async () => {
    const day = utcDay('2026-04-14');
    const passport = await createPlacedPassport(t, seed, 2, day);

    // Сдельщина 20 ₽, чтобы видеть отдельные слагаемые в totalCost.
    await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 2,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(20),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: day,
      },
    });
    await writePacked(t, passport.id, seed.employees.packer.id, at(day, 11, 0), 2);

    // POSTED MaterialIssue на этот паспорт — totalCost = 1 234.56 ₽.
    const order = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passport.id },
      select: { orderId: true },
    });
    const issue = await t.prisma.materialIssue.create({
      data: {
        orderId: order.orderId,
        passportId: passport.id,
        status: 'POSTED',
        postedAt: at(day, 12, 0),
        totalCost: new Prisma.Decimal('1234.56'),
        lines: {
          create: [
            {
              description: 'Кулирка чёрная',
              unit: 'кг',
              issuedQty: new Prisma.Decimal('1'),
              unitCost: new Prisma.Decimal('1234.56'),
              totalCost: new Prisma.Decimal('1234.56'),
            },
          ],
        },
      },
    });
    expect(issue.id).toBeTruthy();

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-14', dateTo: '2026-04-14' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const d = res.body.days[0];
    expect(d.materialCost).toBeCloseTo(1234.56, 2);
    expect(d.pieceworkCost).toBeCloseTo(20, 2);
    // totalCost = piecework + salary + material; упаковщик-окладник вносит
    // minMs = 1 мин × 1 ₽/мин = 1 ₽ (единственный PACKED).
    expect(d.totalCost).toBeCloseTo(20 + 1234.56 + 1, 2);
    expect(res.body.summary.materialCost).toBeCloseTo(1234.56, 2);
    expect(res.body.summary.totalCost).toBeCloseTo(20 + 1234.56 + 1, 2);
  });

  test('7b. DRAFT MaterialIssue с passportId не включается в materialCost', async () => {
    const day = utcDay('2026-04-15');
    const passport = await createPlacedPassport(t, seed, 1, day);
    await writePacked(t, passport.id, seed.employees.packer.id, at(day, 11, 0), 1);

    const order = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passport.id },
      select: { orderId: true },
    });
    await t.prisma.materialIssue.create({
      data: {
        orderId: order.orderId,
        passportId: passport.id,
        status: 'DRAFT',
        totalCost: new Prisma.Decimal('500.00'),
        lines: {
          create: [
            {
              description: 'Этикетка',
              unit: 'шт',
              issuedQty: new Prisma.Decimal('1'),
              unitCost: new Prisma.Decimal('500.00'),
              totalCost: new Prisma.Decimal('500.00'),
            },
          ],
        },
      },
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-15', dateTo: '2026-04-15' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const d = res.body.days[0];
    expect(d.materialCost).toBe(0);
    // Материал не вошёл (DRAFT); остаётся 1 ₽ оклада упаковщика (minMs).
    expect(d.totalCost).toBeCloseTo(1, 2);
  });

  test('7c. CANCELLED MaterialIssue с passportId не включается в materialCost', async () => {
    const day = utcDay('2026-04-16');
    const passport = await createPlacedPassport(t, seed, 1, day);
    await writePacked(t, passport.id, seed.employees.packer.id, at(day, 11, 0), 1);

    const order = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passport.id },
      select: { orderId: true },
    });
    await t.prisma.materialIssue.create({
      data: {
        orderId: order.orderId,
        passportId: passport.id,
        status: 'CANCELLED',
        cancelledAt: at(day, 12, 0),
        totalCost: new Prisma.Decimal('700.00'),
        lines: {
          create: [
            {
              description: 'Молния',
              unit: 'шт',
              issuedQty: new Prisma.Decimal('1'),
              unitCost: new Prisma.Decimal('700.00'),
              totalCost: new Prisma.Decimal('700.00'),
            },
          ],
        },
      },
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-16', dateTo: '2026-04-16' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const d = res.body.days[0];
    expect(d.materialCost).toBe(0);
    // Материал не вошёл (CANCELLED); остаётся 1 ₽ оклада упаковщика (minMs).
    expect(d.totalCost).toBeCloseTo(1, 2);
  });

  test('7d. POSTED MaterialIssue без passportId (order-level) не включается в materialCost', async () => {
    const day = utcDay('2026-04-17');
    const passport = await createPlacedPassport(t, seed, 1, day);
    await writePacked(t, passport.id, seed.employees.packer.id, at(day, 11, 0), 1);

    const order = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passport.id },
      select: { orderId: true },
    });
    // Order-level POSTED (passportId = null). Сознательно out-of-scope
    // production cost по периоду — без passportId дату упаковки
    // нельзя сопоставить.
    await t.prisma.materialIssue.create({
      data: {
        orderId: order.orderId,
        passportId: null,
        status: 'POSTED',
        postedAt: at(day, 12, 0),
        totalCost: new Prisma.Decimal('999.00'),
        lines: {
          create: [
            {
              description: 'Бирка',
              unit: 'шт',
              issuedQty: new Prisma.Decimal('1'),
              unitCost: new Prisma.Decimal('999.00'),
              totalCost: new Prisma.Decimal('999.00'),
            },
          ],
        },
      },
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-17', dateTo: '2026-04-17' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const d = res.body.days[0];
    expect(d.materialCost).toBe(0);
    // Order-level материал не вошёл; остаётся 1 ₽ оклада упаковщика (minMs).
    expect(d.totalCost).toBeCloseTo(1, 2);
  });

  test('7e. POSTED MaterialIssue с passportId вне периода не включается', async () => {
    const inPeriodDay = utcDay('2026-04-18');
    const outsideDay = utcDay('2026-04-25');

    // Паспорт упакован В ПЕРИОДЕ.
    const inPassport = await createPlacedPassport(t, seed, 1, inPeriodDay);
    await writePacked(
      t,
      inPassport.id,
      seed.employees.packer.id,
      at(inPeriodDay, 11, 0),
      1,
    );
    const inOrder = await t.prisma.passport.findUniqueOrThrow({
      where: { id: inPassport.id },
      select: { orderId: true },
    });

    // Паспорт упакован ВНЕ периода (после `to`).
    const outPassport = await createPlacedPassport(t, seed, 1, outsideDay);
    await writePacked(
      t,
      outPassport.id,
      seed.employees.packer.id,
      at(outsideDay, 11, 0),
      1,
    );
    const outOrder = await t.prisma.passport.findUniqueOrThrow({
      where: { id: outPassport.id },
      select: { orderId: true },
    });
    // POSTED документ привязан к паспорту ВНЕ периода.
    await t.prisma.materialIssue.create({
      data: {
        orderId: outOrder.orderId,
        passportId: outPassport.id,
        status: 'POSTED',
        postedAt: at(outsideDay, 12, 0),
        totalCost: new Prisma.Decimal('888.00'),
        lines: {
          create: [
            {
              description: 'Кулирка',
              unit: 'кг',
              issuedQty: new Prisma.Decimal('1'),
              unitCost: new Prisma.Decimal('888.00'),
              totalCost: new Prisma.Decimal('888.00'),
            },
          ],
        },
      },
    });
    // Контрольный POSTED для in-period паспорта.
    await t.prisma.materialIssue.create({
      data: {
        orderId: inOrder.orderId,
        passportId: inPassport.id,
        status: 'POSTED',
        postedAt: at(inPeriodDay, 12, 0),
        totalCost: new Prisma.Decimal('100.00'),
        lines: {
          create: [
            {
              description: 'Этикетка',
              unit: 'шт',
              issuedQty: new Prisma.Decimal('1'),
              unitCost: new Prisma.Decimal('100.00'),
              totalCost: new Prisma.Decimal('100.00'),
            },
          ],
        },
      },
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-18', dateTo: '2026-04-18' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const d = res.body.days[0];
    // Только 100 ₽ — документ outsideDay не попадает в окно.
    expect(d.materialCost).toBeCloseTo(100, 2);
    expect(res.body.summary.materialCost).toBeCloseTo(100, 2);
  });

  test('7f. Несколько POSTED MaterialIssue по одному паспорту суммируются и попадают в день PACKED', async () => {
    const day = utcDay('2026-04-19');
    const passport = await createPlacedPassport(t, seed, 1, day);
    await writePacked(t, passport.id, seed.employees.packer.id, at(day, 11, 0), 1);

    const order = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passport.id },
      select: { orderId: true },
    });
    // Два POSTED-документа на один паспорт. `MaterialIssueLine` без
    // `workshopNeedId` — это допустимо для production cost: сервис
    // использует `MaterialIssue.totalCost`, а не суммирует строки.
    await t.prisma.materialIssue.create({
      data: {
        orderId: order.orderId,
        passportId: passport.id,
        status: 'POSTED',
        postedAt: at(day, 12, 0),
        totalCost: new Prisma.Decimal('300.00'),
        lines: {
          create: [
            {
              description: 'Этикетка',
              unit: 'шт',
              issuedQty: new Prisma.Decimal('1'),
              unitCost: new Prisma.Decimal('300.00'),
              totalCost: new Prisma.Decimal('300.00'),
              workshopNeedId: null,
            },
          ],
        },
      },
    });
    await t.prisma.materialIssue.create({
      data: {
        orderId: order.orderId,
        passportId: passport.id,
        status: 'POSTED',
        postedAt: at(day, 13, 0),
        totalCost: new Prisma.Decimal('200.50'),
        lines: {
          create: [
            {
              description: 'Бирка',
              unit: 'шт',
              issuedQty: new Prisma.Decimal('1'),
              unitCost: new Prisma.Decimal('200.50'),
              totalCost: new Prisma.Decimal('200.50'),
              workshopNeedId: null,
            },
          ],
        },
      },
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-19', dateTo: '2026-04-19' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(1);
    const d = res.body.days[0];
    expect(d.date).toBe('2026-04-19');
    // 300 + 200.50 = 500.50.
    expect(d.materialCost).toBeCloseTo(500.5, 2);
    // + 1 ₽ оклада упаковщика (minMs, единственный PACKED).
    expect(d.totalCost).toBeCloseTo(501.5, 2);
    expect(res.body.summary.materialCost).toBeCloseTo(500.5, 2);
  });

  test('7g. piecework и salary существующая логика не меняется', async () => {
    // Полный сценарий из теста 1, но БЕЗ MaterialIssue —
    // `materialCost` должен быть 0, остальные суммы — те же.
    const day = utcDay('2026-04-20');
    const passport = await createPlacedPassport(t, seed, 5, day);

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

    await writeStageDone(t, passport.id, 'QC_PASSED', seed.employees.qc.id, at(day, 9, 5));
    await writeStageDone(t, passport.id, 'WTO_PASSED', seed.employees.ironing.id, at(day, 10, 3));
    await writePacked(t, passport.id, seed.employees.packer.id, at(day, 11, 0), 5);
    await createSalary(t, seed.employees.qc.id, day, 480);
    await createSalary(t, seed.employees.ironing.id, day, 480);
    await createSalary(t, seed.employees.packer.id, day, 480);

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-20', dateTo: '2026-04-20' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const d = res.body.days[0];
    expect(d.pieceworkCost).toBeCloseTo(50, 2);
    // ОТК+ВТО+упаковка, каждый один терминал = minMs = 1 мин → 3 ₽.
    expect(d.salaryCost).toBeCloseTo(3, 2);
    expect(d.materialCost).toBe(0);
    expect(d.totalCost).toBeCloseTo(53, 2);
    // Простой = 3 окладника × 480 − 3 мин tracked = 1437 ₽.
    expect(d.idleCost).toBeCloseTo(1437, 2);
  });

  test('7h. MaterialIssueLine без workshopNeedId не мешает: сервис использует issue.totalCost', async () => {
    const day = utcDay('2026-04-21');
    const passport = await createPlacedPassport(t, seed, 1, day);
    await writePacked(t, passport.id, seed.employees.packer.id, at(day, 11, 0), 1);

    const order = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passport.id },
      select: { orderId: true },
    });
    // Документ с тремя строками БЕЗ `workshopNeedId`. Сервис
    // `CostsService` берёт `MaterialIssue.totalCost`, а не сумму
    // `MaterialIssueLine.totalCost`, и `workshopNeedId` ему не нужен.
    await t.prisma.materialIssue.create({
      data: {
        orderId: order.orderId,
        passportId: passport.id,
        status: 'POSTED',
        postedAt: at(day, 12, 0),
        totalCost: new Prisma.Decimal('123.45'),
        lines: {
          create: [
            {
              description: 'Подкладка',
              unit: 'м',
              issuedQty: new Prisma.Decimal('1.5'),
              unitCost: new Prisma.Decimal('40'),
              totalCost: new Prisma.Decimal('60'),
              workshopNeedId: null,
            },
            {
              description: 'Этикетка',
              unit: 'шт',
              issuedQty: new Prisma.Decimal('5'),
              unitCost: new Prisma.Decimal('5'),
              totalCost: new Prisma.Decimal('25'),
              workshopNeedId: null,
            },
            {
              description: 'Нитки',
              unit: 'кат',
              issuedQty: new Prisma.Decimal('1'),
              unitCost: new Prisma.Decimal('38.45'),
              totalCost: new Prisma.Decimal('38.45'),
              workshopNeedId: null,
            },
          ],
        },
      },
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-21', dateTo: '2026-04-21' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    const d = res.body.days[0];
    // `materialCost` = `MaterialIssue.totalCost` (123.45), а не Σ строк.
    expect(d.materialCost).toBeCloseTo(123.45, 2);
  });

  test('7i. Daily aggregation: materialCost попадает в день PACKED-event этого паспорта', async () => {
    // Паспорт упакован 22-го, но MaterialIssue.postedAt — 21-го
    // (менеджер мог провести «впрок»). Сервис должен относить
    // расход к дню PACKED, а не к postedAt — это и есть «день
    // выпуска».
    const dayPacked = utcDay('2026-04-22');
    const dayBefore = utcDay('2026-04-21');
    const passport = await createPlacedPassport(t, seed, 1, dayPacked);
    await writePacked(
      t,
      passport.id,
      seed.employees.packer.id,
      at(dayPacked, 11, 0),
      1,
    );

    const order = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passport.id },
      select: { orderId: true },
    });
    await t.prisma.materialIssue.create({
      data: {
        orderId: order.orderId,
        passportId: passport.id,
        status: 'POSTED',
        postedAt: at(dayBefore, 12, 0),
        totalCost: new Prisma.Decimal('250.00'),
        lines: {
          create: [
            {
              description: 'Бирка',
              unit: 'шт',
              issuedQty: new Prisma.Decimal('1'),
              unitCost: new Prisma.Decimal('250.00'),
              totalCost: new Prisma.Decimal('250.00'),
            },
          ],
        },
      },
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/costs/production')
      .query({ dateFrom: '2026-04-21', dateTo: '2026-04-22' })
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(2);
    const day21 = res.body.days.find(
      (d: { date: string }) => d.date === '2026-04-21',
    );
    const day22 = res.body.days.find(
      (d: { date: string }) => d.date === '2026-04-22',
    );
    expect(day21.materialCost).toBe(0);
    expect(day22.materialCost).toBeCloseTo(250, 2);
    expect(res.body.summary.materialCost).toBeCloseTo(250, 2);
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
