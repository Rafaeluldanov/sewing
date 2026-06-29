/**
 * Integration-тесты PHASE 3 STEP 3 «lock-by-line».
 *
 * Покрытие:
 *   A. SalaryEntry: ручной PATCH блокируется, если запись в выплате
 *      ISSUED. Ожидаем 409 PAYROLL_LOCKED.
 *   B. SalaryEntry: PATCH `reset = true` блокируется тем же 409.
 *   C. DRAFT-выплата НЕ блокирует PATCH (черновик ещё пересобирается).
 *   D. CANCELLED-выплата НЕ блокирует PATCH (snapshot снят).
 *   E. ACKNOWLEDGED тоже блокирует (issue + ack ⇒ 409).
 *   F. Авто-`syncDailySalary` (`POST /api/shifts/start`) не падает на
 *      locked entry и не переписывает её `amount` (silent skip).
 *
 * См. `apps/api/src/common/errors.ts::PayrollLockedException`,
 * `apps/api/src/modules/salary/salary.service.ts::updateManually`,
 * `apps/api/src/modules/salary/salary.service.ts::syncDailySalary`.
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

describeWithDb('integration — payroll payouts lock-by-line (PHASE 3 STEP 3)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;

  // Период выплат фиксированный — используем тот же диапазон, что и
  // в `payroll-payouts.test.ts`, чтобы исключить «плавающие» сегодня-
  // зависимые dates.
  const PERIOD_FROM = '2026-04-01';
  const PERIOD_TO = '2026-04-30';
  const SAL_DATE = new Date(`${PERIOD_FROM}T00:00:00.000Z`);

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

    // ОТК — на оклад: иначе SalaryEntry физически нельзя создать
    // через sync-путь (для `reset` тоже нужна `salaryPerHour`).
    // 375 ₽/ч × 8 ч = 3000 ₽ — совпадает с прежними суммами тестов.
    await t.prisma.employee.update({
      where: { id: seed.employees.qc.id },
      data: {
        compensationType: 'SALARY',
        salaryPerHour: new Prisma.Decimal(375),
      },
    });

    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      qc: loginAs(t, seed.employees['qc']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      admin: t.adminCookie,
    };
  });

  // -------------------------------------------------------------------------
  // A. SalaryEntry manual PATCH locked after ISSUE
  // -------------------------------------------------------------------------

  test('A: PATCH /api/salary/:id → 409 PAYROLL_LOCKED, если SalaryEntry в ISSUED-выплате', async () => {
    const entry = await createSalaryEntry(t, seed.employees.qc.id);
    const payoutId = await createAndIssuePayout(t, cookies.manager, seed.employees.qc.id);

    // Sanity-check: snapshot подцепил нашу запись.
    const linkedLines = await t.prisma.payrollPayoutLine.findMany({
      where: { payoutId, salaryEntryId: entry.id },
    });
    expect(linkedLines).toHaveLength(1);

    const res = await request(t.app.getHttpServer())
      .patch(`/api/salary/${entry.id}`)
      .set('Cookie', cookies.manager)
      .send({ amount: 4500 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYROLL_LOCKED');

    // Запись не изменилась.
    const after = await t.prisma.salaryEntry.findUnique({ where: { id: entry.id } });
    expect(Number(after!.amount)).toBeCloseTo(3000, 2);
    expect(after!.editedManually).toBe(false);
  });

  // -------------------------------------------------------------------------
  // B. SalaryEntry reset locked after ISSUE
  // -------------------------------------------------------------------------

  test('B: PATCH /api/salary/:id { reset:true } → 409 PAYROLL_LOCKED для ISSUED', async () => {
    // Создаём отредактированную запись, чтобы `reset` имел смысл.
    const entry = await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: SAL_DATE,
        amount: new Prisma.Decimal(9999),
        source: 'SHIFT_DAY',
        editedManually: true,
        managerComment: 'Старая правка',
      },
    });
    await createAndIssuePayout(t, cookies.manager, seed.employees.qc.id);

    const res = await request(t.app.getHttpServer())
      .patch(`/api/salary/${entry.id}`)
      .set('Cookie', cookies.manager)
      .send({ reset: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYROLL_LOCKED');

    const after = await t.prisma.salaryEntry.findUnique({ where: { id: entry.id } });
    expect(Number(after!.amount)).toBeCloseTo(9999, 2);
    expect(after!.editedManually).toBe(true);
  });

  // -------------------------------------------------------------------------
  // C. DRAFT does NOT lock
  // -------------------------------------------------------------------------

  test('C: PATCH /api/salary/:id 200, если выплата только DRAFT', async () => {
    const entry = await createSalaryEntry(t, seed.employees.qc.id);
    // Создаём DRAFT, но НЕ issue.
    const draft = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.qc.id,
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
      });
    expect(draft.status).toBeLessThan(300);
    expect(draft.body.status).toBe('DRAFT');

    const res = await request(t.app.getHttpServer())
      .patch(`/api/salary/${entry.id}`)
      .set('Cookie', cookies.manager)
      .send({ amount: 3500 });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBeCloseTo(3500, 2);
    expect(res.body.editedManually).toBe(true);
  });

  // -------------------------------------------------------------------------
  // D. CANCELLED does NOT lock
  // -------------------------------------------------------------------------

  test('D: PATCH /api/salary/:id 200 после cancel выплаты', async () => {
    const entry = await createSalaryEntry(t, seed.employees.qc.id);
    const payoutId = await createAndIssuePayout(t, cookies.manager, seed.employees.qc.id);

    // Отменяем выплату — строка снова свободна.
    const cancel = await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${payoutId}/cancel`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'test' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('CANCELLED');

    const res = await request(t.app.getHttpServer())
      .patch(`/api/salary/${entry.id}`)
      .set('Cookie', cookies.manager)
      .send({ amount: 3700 });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBeCloseTo(3700, 2);
  });

  // -------------------------------------------------------------------------
  // E. ACKNOWLEDGED locks
  // -------------------------------------------------------------------------

  test('E: PATCH /api/salary/:id → 409 PAYROLL_LOCKED после issue + ack', async () => {
    const entry = await createSalaryEntry(t, seed.employees.qc.id);
    const payoutId = await createAndIssuePayout(t, cookies.manager, seed.employees.qc.id);

    const ack = await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${payoutId}/ack`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe('ACKNOWLEDGED');

    const res = await request(t.app.getHttpServer())
      .patch(`/api/salary/${entry.id}`)
      .set('Cookie', cookies.manager)
      .send({ amount: 5000 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYROLL_LOCKED');
  });

  // -------------------------------------------------------------------------
  // F. syncDailySalary не переписывает locked entry
  // -------------------------------------------------------------------------

  test('F: start shift не переписывает amount у locked SalaryEntry и не падает', async () => {
    // Создаём salary за СЕГОДНЯ (sync смотрит на startedAt::date),
    // чтобы `start shift` действительно попал в этот же day-bucket.
    const today = startOfUtcDay(new Date());
    const lockedEntry = await t.prisma.salaryEntry.create({
      data: {
        employeeId: seed.employees.qc.id,
        date: today,
        amount: new Prisma.Decimal(7777),
        source: 'SHIFT_DAY',
      },
    });
    const periodFrom = toDateOnly(today);
    const periodTo = toDateOnly(today);

    const draft = await request(t.app.getHttpServer())
      .post('/api/payroll/payouts')
      .set('Cookie', cookies.manager)
      .send({
        employeeId: seed.employees.qc.id,
        periodFrom,
        periodTo,
      });
    expect(draft.status).toBeLessThan(300);

    const issued = await request(t.app.getHttpServer())
      .post(`/api/payroll/payouts/${draft.body.id}/issue`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe('ISSUED');

    // Закрытая смена 8 ч в этот же день — чтобы sync посчитал ненулевую
    // сумму (8 × 375 = 3000) и реально дошёл до locked-guard (а не вышел
    // раньше из-за нулевых часов). Lock должен silent-skip-нуть запись.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.qc.id,
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
        startedAt: new Date(today.getTime() + 8 * 3600 * 1000),
        endedAt: new Date(today.getTime() + 16 * 3600 * 1000),
      },
    });

    // start shift в этот же день — sync должен silent-skip-нуть
    // locked entry. Не падать.
    const start = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      });
    expect(start.status).toBeLessThan(300);

    const after = await t.prisma.salaryEntry.findUnique({
      where: { id: lockedEntry.id },
    });
    expect(after).not.toBeNull();
    // amount остался 7777 — sync не перезаписал на 3000.
    expect(Number(after!.amount)).toBeCloseTo(7777, 2);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function createSalaryEntry(t: TestApp, employeeId: string) {
  return t.prisma.salaryEntry.create({
    data: {
      employeeId,
      date: new Date('2026-04-01T00:00:00.000Z'),
      amount: new Prisma.Decimal(3000),
      source: 'SHIFT_DAY',
    },
  });
}

/**
 * Создаёт DRAFT-выплату и переводит её в ISSUED. Возвращает `id`.
 *
 * Период фиксированный (`PERIOD_FROM..PERIOD_TO`) — совпадает с
 * `createSalaryEntry` выше, чтобы snapshot гарантированно подцепил
 * запись.
 */
async function createAndIssuePayout(
  t: TestApp,
  managerCookie: string,
  employeeId: string,
): Promise<string> {
  const draft = await request(t.app.getHttpServer())
    .post('/api/payroll/payouts')
    .set('Cookie', managerCookie)
    .send({
      employeeId,
      periodFrom: '2026-04-01',
      periodTo: '2026-04-30',
    });
  if (draft.status >= 300) {
    throw new Error(
      `create payout failed: ${draft.status} ${JSON.stringify(draft.body)}`,
    );
  }

  const issued = await request(t.app.getHttpServer())
    .post(`/api/payroll/payouts/${draft.body.id}/issue`)
    .set('Cookie', managerCookie)
    .send({});
  if (issued.status >= 300) {
    throw new Error(
      `issue payout failed: ${issued.status} ${JSON.stringify(issued.body)}`,
    );
  }
  return draft.body.id as string;
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
