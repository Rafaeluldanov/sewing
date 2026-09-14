/**
 * Регрессионные тесты по аудиту движка расчёта 13.09.2026, срез F1
 * (факт себестоимости: паспорт / выпуск / оклад), группа A2_costs_salary.
 * Проверяют ПРАВИЛЬНОЕ поведение (пробные тесты, воспроизводившие баги,
 * лежали в `tests/scratch/calc_{C,V2}/F1-*.test.ts`).
 *
 *   F1-1  — «был на смене»: месячник (одна строка `MONTH_SALARY` на 1-е
 *           число) получает простой в день ЗАКРЫТОЙ смены, а не 1-го числа;
 *           `MANUAL` / `RECUT` строки без смены простоя не дают.
 *   F1-2  — простой = оплаченные минуты (`SalaryEntry.workedSeconds`) −
 *           разнесённые, а не `480 − разнесённые`; legacy-строка без
 *           `workedSeconds` — фолбэк 480; смена месячника режется тем же
 *           предохранителем K7 (16 ч), что и часы почасовика (ревью).
 *   F1-3  — оклад паспорта, выпущенного в окне, считается на окне самого
 *           паспорта: минуты ОТК накануне `dateFrom` попадают в день
 *           упаковки и в `salaryAllocatedCostRub` v2; дневной отчёт =
 *           живой паспорт = FINAL-снимок. Ревью: норма часов месячника —
 *           по месяцу дня события, а не по `from` окна; окно двигают
 *           только завершения окладных операций; расширение назад не
 *           дальше 60 дней — с предупреждением.
 *   F1-5  — `OPERATION_SCAN` терминала ОТК/ВТО = accept: интервал
 *           `[скан..QC_PASSED]` точный, обед между паспортами на изделие
 *           не ложится; скан швеи accept-ом не считается.
 *   F1-11 — v2: оклад выпуска уже в `totalCostRub`, предупреждение
 *           «не распределён» ключуется на оклад по не выпущенным паспортам,
 *           страница «Отчёт» не прибавляет `salaryWorkingCostRub` второй раз.
 *   F1-15 — дневной отчёт считает паспорт один раз при двух `PACKED`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

const repoRoot = path.resolve(__dirname, '..', '..');

const SALARY_PER_HOUR = 600; // 10 ₽/мин
const MINUTE_RATE = SALARY_PER_HOUR / 60;

const utcDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const at = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00.000Z`);

describeWithDb('integration — себестоимость: оклад / простой (аудит 13.09.2026, F1)', () => {
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
    await refreshAdminCookie(t);
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
    };
  });

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  const http = () => request(t.app.getHttpServer());

  async function setHourly(key: string, perHour = SALARY_PER_HOUR): Promise<void> {
    await t.prisma.employee.update({
      where: { id: seed.employees[key].id },
      data: {
        compensationType: 'SALARY',
        salaryRateMode: 'HOURLY',
        salaryPerHour: new Prisma.Decimal(perHour),
        salaryPerMonth: null,
      },
    });
  }

  let suffix = 0;
  function tag(): string {
    suffix += 1;
    return `${Date.now()}-${suffix}`;
  }

  async function createPassport(opts: {
    day: string;
    qty: number;
    status?: 'IN_PROGRESS' | 'PACKED';
    patternItemId?: string;
    orderNumber?: string;
  }): Promise<{ passportId: string; orderId: string }> {
    const order = await t.prisma.order.create({
      data: {
        number: opts.orderNumber ?? `O-F1-${tag()}`,
        orderDate: utcDay(opts.day),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        ...(opts.patternItemId
          ? { patternItemId: opts.patternItemId, patternNameSnapshot: 'Худи F1' }
          : {}),
        items: {
          create: { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: opts.qty },
        },
      },
    });
    const p = await t.prisma.passport.create({
      data: {
        number: `P-F1-${tag()}`,
        qrCode: `passport:f1-${tag()}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: 'R-F1',
        cutDate: utcDay(opts.day),
        qtyPlan: opts.qty,
        qtyCut: opts.qty,
        qtyGood: opts.qty,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: opts.status ?? 'IN_PROGRESS',
      },
    });
    return { passportId: p.id, orderId: order.id };
  }

  /** `ISSUED_TO_EMPLOYEE → OPERATION_FINISHED` по операции (путь 1). */
  async function issueFinished(
    passportId: string,
    operationId: string,
    employeeId: string,
    from: Date,
    to: Date,
  ): Promise<void> {
    await t.prisma.passportEvent.createMany({
      data: [
        { passportId, type: 'ISSUED_TO_EMPLOYEE', operationId, employeeId, createdAt: from },
        { passportId, type: 'OPERATION_FINISHED', operationId, employeeId, createdAt: to },
      ],
    });
  }

  /** Ровно то, что пишет терминал ОТК: `OPERATION_SCAN` (accept) + `QC_PASSED`. */
  async function qcScanAndPass(passportId: string, scanAt: Date, passAt: Date): Promise<void> {
    await t.prisma.passportEvent.createMany({
      data: [
        {
          passportId,
          type: 'OPERATION_SCAN',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          equipmentId: seed.equipment['qc-station-01'].id,
          qty: 10,
          createdAt: scanAt,
        },
        {
          passportId,
          type: 'QC_PASSED',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          qty: 10,
          createdAt: passAt,
        },
      ],
    });
  }

  async function pack(passportId: string, packedAt: Date, qty: number): Promise<void> {
    await t.prisma.passportEvent.create({
      data: {
        passportId,
        type: 'PACKED',
        operationId: seed.operations.PACKING.id,
        employeeId: seed.employees.packer.id,
        qty,
        createdAt: packedAt,
      },
    });
    await t.prisma.passport.update({ where: { id: passportId }, data: { status: 'PACKED' } });
  }

  async function shiftDay(employeeId: string, day: string, workedSeconds: number | null, amount: number) {
    await t.prisma.salaryEntry.create({
      data: {
        employeeId,
        date: utcDay(day),
        source: 'SHIFT_DAY',
        amount: new Prisma.Decimal(amount),
        workedSeconds,
      },
    });
  }

  async function dailyReport(dateFrom: string, dateTo = dateFrom) {
    const res = await http()
      .get('/api/costs/production')
      .query({ dateFrom, dateTo })
      .set('Cookie', cookies.manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as {
      days: Array<{
        date: string;
        producedUnits: number;
        pieceworkCost: number;
        salaryCost: number;
        totalCost: number;
        trackedMinutes: number;
        idleMinutes: number;
        idleCost: number;
      }>;
      warnings?: string[];
    };
  }

  /** Месячник 96 000 ₽ с нормой сентября 176 ч (545,45 ₽/ч) и августа 168 ч (571,43 ₽/ч). */
  async function setMonthly(key: string): Promise<void> {
    await t.prisma.employee.update({
      where: { id: seed.employees[key].id },
      data: {
        compensationType: 'SALARY',
        salaryRateMode: 'MONTHLY',
        salaryPerMonth: new Prisma.Decimal(96000),
        salaryPerHour: null,
      },
    });
    for (const [month, normHours] of [[8, 168], [9, 176]] as const) {
      await t.prisma.payrollCalendarMonth.upsert({
        where: { PayrollCalendarMonth_year_month_uniq: { year: 2026, month } },
        create: { year: 2026, month, normDays: 22, normHours: new Prisma.Decimal(normHours) },
        update: { normHours: new Prisma.Decimal(normHours) },
      });
    }
  }

  async function v2Report(dateFrom: string, dateTo = dateFrom) {
    const res = await http()
      .get('/api/admin/production-cost/v2')
      .query({ dateFrom, dateTo })
      .set('Cookie', cookies.manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as {
      totals: {
        releasedQty: number;
        operationPieceworkCostRub: string;
        salaryAllocatedCostRub: string;
        totalCostRub: string;
        salaryWorkingCostRub: string;
        salaryWorkingMinutes: number;
        idleSalaryCostRub: string;
        idleSalaryMinutes: number;
      };
      nomenclatureGroups: Array<{
        salaryAllocatedCostRub: string;
        operationMatrix: Array<{ operationName: string; kind: string; minutes: number; rub: string }>;
      }>;
      orderGroups: Array<{ orderId: string; releasedQty: number; salaryAllocatedCostRub: string; totalCostRub: string }>;
      salaryOperationBreakdown: Array<{ operationName: string; minutes: number; rub: string }>;
      warnings: string[];
    };
  }

  async function passportCost(passportId: string) {
    const res = await http().get(`/api/costs/passport/${passportId}`).set('Cookie', cookies.manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as {
      salaryCost: number;
      isFinal: boolean;
      salaryLines: Array<{ minutes: number; rub: number; operationName: string | null }>;
    };
  }

  // ---------------------------------------------------------------------------
  // F1-1 — «был на смене»
  // ---------------------------------------------------------------------------

  test('F1-1: месячник — простой в день закрытой смены, а не 1-го числа (MONTH_SALARY)', async () => {
    const qc = seed.employees.qc.id;
    await t.prisma.employee.update({
      where: { id: qc },
      data: {
        compensationType: 'SALARY',
        salaryRateMode: 'MONTHLY',
        salaryPerMonth: new Prisma.Decimal(96000),
        salaryPerHour: null,
      },
    });
    // Норма сентября 176 ч → 545,45 ₽/ч.
    await t.prisma.payrollCalendarMonth.upsert({
      where: { PayrollCalendarMonth_year_month_uniq: { year: 2026, month: 9 } },
      create: { year: 2026, month: 9, normDays: 22, normHours: new Prisma.Decimal(176) },
      update: { normHours: new Prisma.Decimal(176) },
    });
    const minuteRate = 545.45 / 60;
    // Единственная строка месячника — как её создаёт `syncMonthlySalary`.
    await t.prisma.salaryEntry.create({
      data: {
        employeeId: qc,
        date: utcDay('2026-09-01'),
        amount: new Prisma.Decimal(96000),
        source: 'MONTH_SALARY',
        workedSeconds: 8 * 3600,
      },
    });
    // Реальная закрытая смена 02.09 (8 ч) + 6 разнесённых минут ОТК.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: qc,
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
        startedAt: at('2026-09-02', '08:00'),
        endedAt: at('2026-09-02', '16:00'),
      },
    });
    const { passportId } = await createPassport({ day: '2026-09-02', qty: 5 });
    await issueFinished(passportId, seed.operations.QC.id, qc, at('2026-09-02', '08:00'), at('2026-09-02', '08:06'));
    await pack(passportId, at('2026-09-02', '12:00'), 5);

    const body = await dailyReport('2026-09-01', '2026-09-02');
    const d1 = body.days.find((d) => d.date === '2026-09-01')!;
    const d2 = body.days.find((d) => d.date === '2026-09-02')!;
    // 01.09 — смен нет: строка MONTH_SALARY не признак присутствия.
    expect(d1.idleMinutes).toBe(0);
    expect(d1.idleCost).toBe(0);
    // 02.09 — смена 480 мин, разнесено 6 → простой 474 × 9,09 ₽.
    expect(d2.trackedMinutes).toBe(6);
    expect(d2.idleMinutes).toBe(474);
    expect(d2.idleCost).toBeCloseTo(474 * minuteRate, 1);

    const v2 = await v2Report('2026-09-01', '2026-09-02');
    expect(v2.totals.idleSalaryMinutes).toBeCloseTo(474, 1);
    expect(Number(v2.totals.idleSalaryCostRub)).toBeCloseTo(474 * minuteRate, 1);
  });

  test('F1-1: MANUAL-премия и RECUT-доплата без смены простоя не дают', async () => {
    await setHourly('ironing');
    await setHourly('qc');
    await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.ironing.id,
        date: utcDay('2026-09-05'),
        amount: new Prisma.Decimal(3000),
        source: 'MANUAL',
      },
    });
    await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: utcDay('2026-09-05'),
        amount: new Prisma.Decimal(300),
        source: 'RECUT',
        workedSeconds: 1800,
      },
    });
    const body = await dailyReport('2026-09-05');
    expect(body.days[0].idleMinutes).toBe(0);
    expect(body.days[0].idleCost).toBe(0);
    const v2 = await v2Report('2026-09-05');
    expect(v2.totals.idleSalaryMinutes).toBe(0);
    expect(v2.totals.idleSalaryCostRub).toBe('0.00');
  });

  // ---------------------------------------------------------------------------
  // F1-2 — простой от оплаченных минут
  // ---------------------------------------------------------------------------

  async function seedHalfShiftCase(workedSeconds: number | null, amount: number) {
    await setHourly('qc');
    const DAY = '2026-04-23';
    await shiftDay(seed.employees.qc.id, DAY, workedSeconds, amount);
    const { passportId } = await createPassport({ day: DAY, qty: 5 });
    // ОТК держал паспорт ровно 60 мин (= cap, не режется) → 600 ₽ рабочей части.
    await issueFinished(passportId, seed.operations.QC.id, seed.employees.qc.id, at(DAY, '08:00'), at(DAY, '09:00'));
    await pack(passportId, at(DAY, '12:00'), 5);
    const day = (await dailyReport(DAY)).days[0];
    const v2 = (await v2Report(DAY)).totals;
    return { day, v2 };
  }

  test('F1-2: полсмены (240 оплаченных мин) при 60 разнесённых → простой 180 мин / 1 800 ₽; рабочая + простой = выплате', async () => {
    const { day, v2 } = await seedHalfShiftCase(14_400, 2_400);
    expect(day.trackedMinutes).toBe(60);
    expect(day.salaryCost).toBeCloseTo(600, 2);
    expect(day.idleMinutes).toBe(180);
    expect(day.idleCost).toBeCloseTo(1_800, 2);
    expect(day.salaryCost + day.idleCost).toBeCloseTo(2_400, 2);
    expect(v2.idleSalaryMinutes).toBeCloseTo(180, 1);
    expect(Number(v2.idleSalaryCostRub)).toBeCloseTo(1_800, 2);
    expect(Number(v2.salaryWorkingCostRub)).toBeCloseTo(600, 2);
  });

  test('F1-2: переработка (600 оплаченных мин) → простой 540 мин / 5 400 ₽', async () => {
    const { day, v2 } = await seedHalfShiftCase(36_000, 6_000);
    expect(day.idleMinutes).toBe(540);
    expect(day.idleCost).toBeCloseTo(5_400, 2);
    expect(day.salaryCost + day.idleCost).toBeCloseTo(6_000, 2);
    expect(v2.idleSalaryMinutes).toBeCloseTo(540, 1);
    expect(Number(v2.idleSalaryCostRub)).toBeCloseTo(5_400, 2);
  });

  test('F1-2: legacy-строка без workedSeconds → фолбэк 480 (простой 420 мин / 4 200 ₽)', async () => {
    const { day, v2 } = await seedHalfShiftCase(null, 4_800);
    expect(day.idleMinutes).toBe(420);
    expect(day.idleCost).toBeCloseTo(4_200, 2);
    expect(v2.idleSalaryMinutes).toBeCloseTo(420, 1);
  });

  test('F1-2 (ревью): забытая смена месячника пт→пн режется предохранителем 16 ч — простой 954 мин, а не 4 374', async () => {
    await setMonthly('qc');
    const qc = seed.employees.qc.id;
    const minuteRate = 545.45 / 60;
    // Смена открыта в пятницу 08:00, закрыта «Завершить смену» в понедельник 09:00 (73 ч).
    await t.prisma.shiftSession.create({
      data: {
        employeeId: qc,
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
        startedAt: at('2026-09-04', '08:00'),
        endedAt: at('2026-09-07', '09:00'),
      },
    });
    const { passportId } = await createPassport({ day: '2026-09-04', qty: 5 });
    await issueFinished(passportId, seed.operations.QC.id, qc, at('2026-09-04', '08:00'), at('2026-09-04', '08:06'));
    await pack(passportId, at('2026-09-04', '12:00'), 5);

    const day = (await dailyReport('2026-09-04')).days[0];
    expect(day.trackedMinutes).toBe(6);
    // Оплачено = 16 ч = 960 мин (как `computeWorkedSeconds` в ведомости), а не 4 380.
    expect(day.idleMinutes).toBe(954);
    expect(day.idleCost).toBeCloseTo(954 * minuteRate, 1);

    const v2 = await v2Report('2026-09-04');
    expect(v2.totals.idleSalaryMinutes).toBeCloseTo(954, 1);
    expect(Number(v2.totals.idleSalaryCostRub)).toBeCloseTo(954 * minuteRate, 1);
  });

  // ---------------------------------------------------------------------------
  // F1-3 — оклад выпущенного паспорта на окне паспорта
  // ---------------------------------------------------------------------------

  test('F1-3: ОТК накануне упаковки попадает в день упаковки, в v2 allocated и совпадает с FINAL-снимком', async () => {
    await setHourly('qc');
    await setHourly('packer');
    const { passportId, orderId } = await createPassport({ day: '2026-08-31', qty: 5 });
    // 31.08: ОТК 30 мин = 300 ₽; 01.09: упаковка 5 мин = 50 ₽.
    await issueFinished(passportId, seed.operations.QC.id, seed.employees.qc.id, at('2026-08-31', '10:00'), at('2026-08-31', '10:30'));
    await t.prisma.passportEvent.create({
      data: {
        passportId,
        type: 'ISSUED_TO_EMPLOYEE',
        operationId: seed.operations.PACKING.id,
        employeeId: seed.employees.packer.id,
        createdAt: at('2026-09-01', '09:00'),
      },
    });
    await pack(passportId, at('2026-09-01', '09:05'), 5);

    // Эталон — живой паспорт.
    const live = await passportCost(passportId);
    expect(live.salaryCost).toBeCloseTo(350, 2);

    // Однодневный отчёт за день упаковки — весь оклад паспорта.
    const packDay = (await dailyReport('2026-09-01')).days[0];
    expect(packDay.producedUnits).toBe(5);
    expect(packDay.salaryCost).toBeCloseTo(350, 2);
    // Учтённые минуты остаются по дню событий (простой считается по дню).
    expect(packDay.trackedMinutes).toBe(5);
    const qcDay = (await dailyReport('2026-08-31')).days[0];
    expect(qcDay.producedUnits).toBe(0);
    expect(qcDay.trackedMinutes).toBe(30);
    expect(qcDay.salaryCost).toBe(0);
    // Число дня не зависит от ширины окна.
    const wide = await dailyReport('2026-08-31', '2026-09-01');
    expect(wide.days.find((d) => d.date === '2026-09-01')!.salaryCost).toBeCloseTo(350, 2);

    // v2: сентябрь — allocated 350 (и он же в totalCostRub); рабочая часть
    // периода — только сентябрьские 50; август — allocated 0, working 300 и
    // предупреждение о нераспределённом окладе с суммой.
    const sep = await v2Report('2026-09-01', '2026-09-30');
    expect(sep.orderGroups).toHaveLength(1);
    expect(sep.orderGroups[0].orderId).toBe(orderId);
    expect(sep.orderGroups[0].salaryAllocatedCostRub).toBe('350.00');
    expect(sep.totals.salaryAllocatedCostRub).toBe('350.00');
    expect(sep.totals.totalCostRub).toBe('350.00');
    expect(sep.totals.salaryWorkingCostRub).toBe('50.00');
    expect(sep.warnings.some((w) => w.includes('не выпущенным'))).toBe(false);
    const aug = await v2Report('2026-08-01', '2026-08-31');
    expect(aug.totals.salaryAllocatedCostRub).toBe('0.00');
    expect(aug.totals.salaryWorkingCostRub).toBe('300.00');
    expect(aug.warnings.some((w) => w.includes('не выпущенным') && w.includes('300.00'))).toBe(true);

    // FINAL-снимок за день упаковки = дневной отчёт = живой паспорт.
    const fin = await http()
      .post('/api/costs/snapshots/finalize')
      .query({ date: '2026-09-01' })
      .set('Cookie', cookies.manager);
    expect(fin.status).toBe(201);
    const snap = await t.prisma.passportCostSnapshot.findUniqueOrThrow({ where: { passportId } });
    expect(Number(snap.salaryCostRub)).toBeCloseTo(350, 2);
    expect((await dailyReport('2026-09-01')).days[0].salaryCost).toBeCloseTo(Number(snap.salaryCostRub), 2);
  });

  test('F1-3 (ревью): норма месячника — по месяцу дня события: сентябрьский ОТК по норме сентября даже при окне, расширенном в август', async () => {
    await setMonthly('qc');
    await setHourly('packer');
    const qc = seed.employees.qc.id;
    const augMinute = 96000 / 168 / 60; // 9,5238 ₽/мин
    const sepMinute = 96000 / 176 / 60; // 9,0909 ₽/мин

    // A: ОТК 31.08 (30 мин, норма августа), упаковка 02.09 (5 мин × 10 ₽).
    const a = await createPassport({ day: '2026-08-31', qty: 5, orderNumber: 'O-F13-A' });
    await issueFinished(a.passportId, seed.operations.QC.id, qc, at('2026-08-31', '10:00'), at('2026-08-31', '10:30'));
    await t.prisma.passportEvent.create({
      data: { passportId: a.passportId, type: 'ISSUED_TO_EMPLOYEE', operationId: seed.operations.PACKING.id, employeeId: seed.employees.packer.id, createdAt: at('2026-09-02', '09:00') },
    });
    await pack(a.passportId, at('2026-09-02', '09:05'), 5);
    // B: ОТК 02.09 (30 мин, норма сентября), упаковка 02.09.
    const b = await createPassport({ day: '2026-09-02', qty: 5, orderNumber: 'O-F13-B' });
    await issueFinished(b.passportId, seed.operations.QC.id, qc, at('2026-09-02', '10:00'), at('2026-09-02', '10:30'));
    await t.prisma.passportEvent.create({
      data: { passportId: b.passportId, type: 'ISSUED_TO_EMPLOYEE', operationId: seed.operations.PACKING.id, employeeId: seed.employees.packer.id, createdAt: at('2026-09-02', '12:00') },
    });
    await pack(b.passportId, at('2026-09-02', '12:05'), 5);

    const expectedA = 30 * augMinute + 50;
    const expectedB = 30 * sepMinute + 50;
    // Живые паспорта — эталон (у каждого своё окно).
    expect((await passportCost(a.passportId)).salaryCost).toBeCloseTo(expectedA, 1);
    expect((await passportCost(b.passportId)).salaryCost).toBeCloseTo(expectedB, 1);

    // Отчёт за сентябрь: окно расширено к 31.08, но B считается по норме
    // сентября (раньше — по августовской, +4,8 %).
    const sep = await v2Report('2026-09-01', '2026-09-30');
    const groupA = sep.orderGroups.find((g) => g.orderId === a.orderId)!;
    const groupB = sep.orderGroups.find((g) => g.orderId === b.orderId)!;
    expect(Number(groupA.salaryAllocatedCostRub)).toBeCloseTo(expectedA, 1);
    expect(Number(groupB.salaryAllocatedCostRub)).toBeCloseTo(expectedB, 1);
    expect(sep.warnings.some((w) => w.includes('окно разноса'))).toBe(false);
    const day = (await dailyReport('2026-09-02')).days[0];
    expect(day.salaryCost).toBeCloseTo(expectedA + expectedB, 1);
    expect(day.warnings ?? []).toEqual([]);
  });

  test('F1-3 (ревью): OPERATION_FINISHED швеи-сдельщицы окно не двигает; ретро-ОТК старше 60 дней — окно ограничено и есть предупреждение', async () => {
    await setHourly('qc');
    await setHourly('packer');
    // C: швея закрыла операцию в июне (сдельщица), ОТК и упаковка 02.09 —
    // окно не уезжает в июнь, предупреждения нет, оклад = 30 × 10 + 5 × 10.
    const c = await createPassport({ day: '2026-06-01', qty: 5, orderNumber: 'O-F13-C' });
    await issueFinished(c.passportId, seed.operations.SEW_OVERLOCK_1.id, seed.employees.seamstress.id, at('2026-06-01', '10:00'), at('2026-06-01', '10:30'));
    await issueFinished(c.passportId, seed.operations.QC.id, seed.employees.qc.id, at('2026-09-02', '10:00'), at('2026-09-02', '10:30'));
    await t.prisma.passportEvent.create({
      data: { passportId: c.passportId, type: 'ISSUED_TO_EMPLOYEE', operationId: seed.operations.PACKING.id, employeeId: seed.employees.packer.id, createdAt: at('2026-09-02', '11:00') },
    });
    await pack(c.passportId, at('2026-09-02', '11:05'), 5);

    const clean = await dailyReport('2026-09-02');
    expect(clean.days[0].salaryCost).toBeCloseTo(350, 2);
    expect(clean.warnings ?? []).toEqual([]);
    expect((await v2Report('2026-09-02')).warnings.some((w) => w.includes('окно разноса'))).toBe(false);

    // D: ОТК окладника 01.06 (93 дня назад), упаковка 03.09 — окно назад не
    // дальше 60 дней, июньские минуты не учтены, отчёт предупреждает.
    const d = await createPassport({ day: '2026-06-01', qty: 5, orderNumber: 'O-F13-D' });
    await issueFinished(d.passportId, seed.operations.QC.id, seed.employees.qc.id, at('2026-06-01', '10:00'), at('2026-06-01', '10:30'));
    await t.prisma.passportEvent.create({
      data: { passportId: d.passportId, type: 'ISSUED_TO_EMPLOYEE', operationId: seed.operations.PACKING.id, employeeId: seed.employees.packer.id, createdAt: at('2026-09-03', '09:00') },
    });
    await pack(d.passportId, at('2026-09-03', '09:05'), 5);

    const capped = await dailyReport('2026-09-03');
    expect(capped.days[0].salaryCost).toBeCloseTo(50, 2);
    expect(capped.warnings ?? []).toHaveLength(1);
    expect(capped.warnings![0]).toContain('60 дн.');
    expect(capped.warnings![0]).toContain('2026-06-01');
    const v2 = await v2Report('2026-09-03');
    expect(v2.warnings.some((w) => w.includes('окно разноса') && w.includes('60 дн.'))).toBe(true);
    expect(Number(v2.totals.salaryAllocatedCostRub)).toBeCloseTo(50, 2);
  });

  // ---------------------------------------------------------------------------
  // F1-5 — OPERATION_SCAN как accept ОТК/ВТО
  // ---------------------------------------------------------------------------

  test('F1-5: интервал скан → QC_PASSED точный: A = 10 мин / 100 ₽, B = 40 мин / 400 ₽; дневной отчёт и FINAL согласованы', async () => {
    await setHourly('qc');
    const DAY = '2026-06-10';
    const A = (await createPassport({ day: DAY, qty: 10 })).passportId;
    const B = (await createPassport({ day: DAY, qty: 10 })).passportId;
    await qcScanAndPass(A, at(DAY, '08:50'), at(DAY, '09:00'));
    await qcScanAndPass(B, at(DAY, '09:05'), at(DAY, '09:45'));

    const a = await passportCost(A);
    const b = await passportCost(B);
    expect(a.salaryLines).toHaveLength(1);
    expect(a.salaryLines[0].minutes).toBeCloseTo(10, 1);
    expect(a.salaryCost).toBeCloseTo(10 * MINUTE_RATE, 2);
    expect(b.salaryLines[0].minutes).toBeCloseTo(40, 1);
    expect(b.salaryCost).toBeCloseTo(40 * MINUTE_RATE, 2);

    await pack(A, at(DAY, '12:00'), 10);
    await pack(B, at(DAY, '12:05'), 10);
    await shiftDay(seed.employees.qc.id, DAY, 8 * 3600, 8 * SALARY_PER_HOUR);
    const d = (await dailyReport(DAY)).days[0];
    expect(d.trackedMinutes).toBe(50);
    expect(d.idleMinutes).toBe(430);
    expect(d.idleCost).toBeCloseTo(430 * MINUTE_RATE, 2);
    expect(d.salaryCost).toBeCloseTo(50 * MINUTE_RATE, 2);

    const fin = await http()
      .post('/api/costs/snapshots/finalize')
      .query({ date: DAY })
      .set('Cookie', cookies.manager);
    expect(fin.status).toBe(201);
    expect(fin.body.finalized).toBe(2);
    const bFinal = await passportCost(B);
    expect(bFinal.isFinal).toBe(true);
    expect(bFinal.salaryCost).toBeCloseTo(400, 2);
  });

  test('F1-5: обед между паспортами на изделие не ложится: C = 5 мин / 50 ₽, D = 10 мин / 100 ₽', async () => {
    await setHourly('qc');
    const DAY = '2026-06-10';
    const C = (await createPassport({ day: DAY, qty: 10 })).passportId;
    const D = (await createPassport({ day: DAY, qty: 10 })).passportId;
    await qcScanAndPass(C, at(DAY, '11:50'), at(DAY, '11:55'));
    await qcScanAndPass(D, at(DAY, '13:00'), at(DAY, '13:10')); // обед 11:55–13:00
    const c = await passportCost(C);
    const dd = await passportCost(D);
    expect(c.salaryLines[0].minutes).toBeCloseTo(5, 1);
    expect(c.salaryCost).toBeCloseTo(5 * MINUTE_RATE, 2);
    expect(dd.salaryLines[0].minutes).toBeCloseTo(10, 1);
    expect(dd.salaryCost).toBeCloseTo(10 * MINUTE_RATE, 2);
  });

  test('F1-5: скан на швейной операции accept-ом не считается — у швеи по-прежнему ISSUED_TO_EMPLOYEE', async () => {
    // MIXED-швея с окладом: скан в 08:00, выдача в 08:30, завершение в 08:40 → 10 мин, а не 40.
    await t.prisma.employee.update({
      where: { id: seed.employees.seamstress.id },
      data: { compensationType: 'MIXED', salaryRateMode: 'HOURLY', salaryPerHour: new Prisma.Decimal(SALARY_PER_HOUR) },
    });
    const DAY = '2026-06-11';
    const P = (await createPassport({ day: DAY, qty: 10 })).passportId;
    const op = seed.operations.SEW_OVERLOCK_1.id;
    const emp = seed.employees.seamstress.id;
    await t.prisma.passportEvent.createMany({
      data: [
        { passportId: P, type: 'OPERATION_SCAN', operationId: op, employeeId: emp, createdAt: at(DAY, '08:00') },
        { passportId: P, type: 'ISSUED_TO_EMPLOYEE', operationId: op, employeeId: emp, createdAt: at(DAY, '08:30') },
        { passportId: P, type: 'OPERATION_FINISHED', operationId: op, employeeId: emp, createdAt: at(DAY, '08:40') },
      ],
    });
    const p = await passportCost(P);
    expect(p.salaryLines).toHaveLength(1);
    expect(p.salaryLines[0].minutes).toBeCloseTo(10, 1);
    expect(p.salaryCost).toBeCloseTo(10 * MINUTE_RATE, 2);
  });

  test('F1-5: реальный терминал ОТК (shifts/start → scan → qc/complete) пишет OPERATION_SCAN, и движок считает по нему', async () => {
    await setHourly('qc');
    const order = await http()
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-06-01T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      })
      .expect(201);
    const orderId: string = order.body.id;
    await http().post(`/api/orders/${orderId}/start`).set('Cookie', cookies.manager).send({}).expect(201);
    const passport = await http()
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-F15-API',
        cutDate: '2026-06-01T00:00:00.000Z',
        qtyCut: 5,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passport.body.id;
    await http().post(`/api/passports/${passportId}/place`).set('Cookie', cookies.manager).send({ cellId: seed.cells.A1.id }).expect(201);
    await http()
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({ equipmentId: seed.equipment['overlock-01'].id, operationId: seed.operations.SEW_OVERLOCK_1.id })
      .expect(201);
    await http().post(`/api/passports/${passportId}/issue`).set('Cookie', cookies.seamstress).send({}).expect(201);
    await http().post(`/api/passports/${passportId}/complete-operation`).set('Cookie', cookies.seamstress).send({});

    await http()
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({ equipmentId: seed.equipment['qc-station-01'].id, operationId: seed.operations.QC.id })
      .expect(201);
    await http().post(`/api/passports/${passportId}/scan`).set('Cookie', cookies.qc).send({}).expect(201);
    await http().post(`/api/qc/passports/${passportId}/complete`).set('Cookie', cookies.qc).send({}).expect(201);

    const events = await t.prisma.passportEvent.findMany({
      where: { passportId, employeeId: seed.employees.qc.id, operationId: seed.operations.QC.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, type: true, createdAt: true },
    });
    const scan = events.find((e) => e.type === 'OPERATION_SCAN')!;
    const passed = events.find((e) => e.type === 'QC_PASSED')!;
    expect(scan).toBeDefined();
    expect(passed).toBeDefined();
    expect(events.some((e) => e.type === 'ISSUED_TO_EMPLOYEE')).toBe(false);

    // Терминал прошёл за миллисекунды — отодвигаем скан на 10 минут назад
    // (форма событий при этом ровно та, что пишет прод).
    await t.prisma.passportEvent.update({
      where: { id: scan.id },
      data: { createdAt: new Date(passed.createdAt.getTime() - 10 * 60_000) },
    });
    const cost = await passportCost(passportId);
    expect(cost.salaryLines).toHaveLength(1);
    expect(cost.salaryLines[0].minutes).toBeCloseTo(10, 1);
    expect(cost.salaryCost).toBeCloseTo(10 * MINUTE_RATE, 2);
  });

  // ---------------------------------------------------------------------------
  // F1-11 — витрины v2 и страница «Отчёт»
  // ---------------------------------------------------------------------------

  async function seedF111(): Promise<{ A: string; B: string }> {
    await setHourly('qc');
    const pattern = await t.prisma.patternItem.create({
      data: { name: 'Худи F1', article: `HD-F1-${tag()}`, status: 'ACTIVE' },
    });
    const DAY = '2026-06-15';
    // A — упакован в D, ОТК 10 мин = 100 ₽.
    const A = (await createPassport({ day: DAY, qty: 5, patternItemId: pattern.id, orderNumber: 'O-F111-A' })).passportId;
    await issueFinished(A, seed.operations.QC.id, seed.employees.qc.id, at(DAY, '08:00'), at(DAY, '08:10'));
    await pack(A, at(DAY, '09:00'), 5);
    // B — не упакован, ОТК 30 мин = 300 ₽.
    const B = (await createPassport({ day: DAY, qty: 5, patternItemId: pattern.id, orderNumber: 'O-F111-B' })).passportId;
    await issueFinished(B, seed.operations.QC.id, seed.employees.qc.id, at(DAY, '10:00'), at(DAY, '10:30'));
    return { A, B };
  }

  test('F1-11: оклад выпуска внутри totalCostRub; предупреждение — про оклад по не выпущенным паспортам, а не про сделку', async () => {
    const { A, B } = await seedF111();
    const DAY = '2026-06-15';

    const body = await v2Report(DAY);
    // Таблица «Окладные операции» — за период (A + B), матрица — по выпущенным (A).
    const qc = body.salaryOperationBreakdown.find((r) => r.operationName === 'ОТК')!;
    expect(qc.rub).toBe('400.00');
    const matrixQc = body.nomenclatureGroups[0].operationMatrix.find((r) => r.kind === 'SALARY' && r.operationName === 'ОТК')!;
    expect(matrixQc.rub).toBe('100.00');
    expect(body.totals.salaryAllocatedCostRub).toBe('100.00');
    expect(body.totals.totalCostRub).toBe('100.00'); // оклад уже внутри
    expect(body.totals.salaryWorkingCostRub).toBe('400.00');
    // Без сделки предупреждение ЕСТЬ — 300 ₽ паспорта B никуда не распределены.
    expect(body.warnings.some((w) => w.includes('не выпущенным') && w.includes('300.00'))).toBe(true);
    expect(body.warnings).not.toContain('Окладная составляющая не распределена по номенклатуре в этом отчёте');

    // Со сделкой 50 ₽ на A: totalCostRub 150, предупреждение то же (про B), а не «из-за сделки».
    await t.prisma.operationEntry.create({
      data: {
        passportId: A,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 5,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(50),
        status: 'APPROVED',
        approvalMode: 'AFTER_RELEASE',
        sourceEventType: 'OPERATION_TRANSITION',
        approvedAt: at(DAY, '08:30'),
      },
    });
    const withPiece = await v2Report(DAY);
    expect(withPiece.totals.operationPieceworkCostRub).toBe('50.00');
    expect(withPiece.totals.totalCostRub).toBe('150.00');
    expect(withPiece.warnings.some((w) => w.includes('не выпущенным') && w.includes('300.00'))).toBe(true);

    // Если весь оклад периода распределён (B упакован) — предупреждения нет даже при сделке.
    await pack(B, at(DAY, '11:00'), 5);
    const allPacked = await v2Report(DAY);
    expect(allPacked.totals.salaryAllocatedCostRub).toBe('400.00');
    expect(allPacked.totals.totalCostRub).toBe('450.00');
    expect(allPacked.warnings.some((w) => w.includes('не распределён'))).toBe(false);
  });

  test('F1-11: страница «Отчёт» берёт итог из totalCostRub и не прибавляет salaryWorkingCostRub', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/web/app/admin/production-cost/report/page.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/totalCostRub\)\s*\+\s*Number\(totals\.salaryWorkingCostRub\)/);
    expect(src).toMatch(/const cost = totals \? Number\(totals\.totalCostRub\) : 0;/);
    // В расшифровке итога — разнесённый на выпуск оклад, а не рабочая часть периода.
    expect(src).toMatch(/value: totals\.salaryAllocatedCostRub/);
  });

  // ---------------------------------------------------------------------------
  // F1-15 — дедуп PACKED по паспорту в дневном отчёте
  // ---------------------------------------------------------------------------

  test('F1-15: два PACKED у одного паспорта — выпуск и суммы дня считаются один раз', async () => {
    const DAY = '2026-09-02';
    const { passportId } = await createPassport({ day: DAY, qty: 10, status: 'PACKED' });
    await t.prisma.passportEvent.createMany({
      data: [
        { passportId, type: 'PACKED', employeeId: seed.employees.packer.id, qty: 10, createdAt: at(DAY, '10:00') },
        { passportId, type: 'PACKED', employeeId: seed.employees.packer.id, qty: 10, createdAt: at(DAY, '10:30') },
      ],
    });
    await t.prisma.operationEntry.create({
      data: {
        passportId,
        operationId: seed.operations.CUT_CUT.id,
        employeeId: seed.employees.cutter.id,
        qty: 10,
        ratePerUnit: new Prisma.Decimal(5),
        amount: new Prisma.Decimal(50),
        status: 'APPROVED',
      },
    });
    const d = (await dailyReport(DAY)).days[0];
    expect(d.producedUnits).toBe(10);
    expect(d.pieceworkCost).toBeCloseTo(50, 2);
    expect(d.totalCost).toBeCloseTo(50, 2);
    const v2 = await v2Report(DAY);
    expect(v2.totals.releasedQty).toBe(10);
  });
});
