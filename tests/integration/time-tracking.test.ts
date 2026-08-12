/**
 * Integration-тесты «Тайм-трекер сотрудника» (12.08.2026) —
 * `GET /api/admin/employees/time-tracker-summary` и
 * `GET /api/employees/:id/time-tracking`
 * (`apps/api/src/modules/time-tracking/*`).
 *
 * До этой даты тестов у вкладки не было вовсе, а расчёт часов дублировал
 * кабинет мастера — и разъехался с ним на три часа, когда мастер перешёл
 * на московские сутки. Поэтому тесты держат ровно то, что сломалось:
 *
 *   1. Часы берутся из отрезков смен (`ShiftSegment`, общее ядро
 *      `shifts/shift-time.ts`), а не из сеанса целиком: внутри одной
 *      смены с переключением операции время не задваивается.
 *   2. Окно считается ПЕРЕСЕЧЕНИЕМ: смена, начатая до периода, не
 *      пропадает; ушедшая за его конец не засчитывается периоду целиком.
 *   3. Ночная смена делится между сутками в подневной разбивке, а не
 *      падает в день своего начала.
 *   4. Цифры совпадают с вкладкой мастера — это главное обещание обеих
 *      вкладок.
 *   5. RBAC: вкладка админская (SHOP_MANAGER / ADMIN), швею не пускаем.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import type {
  MasterEmployeeDayDto,
  TimeTrackingDto,
  TimeTrackingSummaryDto,
} from '@sewing/shared';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — тайм-трекер сотрудника', () => {
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
      manager: loginAs(t, seed.employees['shop-chief']!),
      seamstress: loginAs(t, seed.employees['seamstress']!),
    };
  });

  const api = () => request(t.app.getHttpServer());

  /**
   * Готовая смена с отрезками. `parts` — куски `[начало, конец]` в
   * абсолютных датах; каждый становится отдельным `ShiftSegment`
   * (как их пишет `switchOperation`).
   */
  const seedShift = async (
    parts: Array<[Date, Date | null]>,
    operationCode: 'SEW_OVERLOCK_1' | 'SEW_OVERLOCK_2' = 'SEW_OVERLOCK_1',
  ) => {
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;
    const session = await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees['seamstress']!.id,
        equipmentId: seed.equipment['overlock-01']!.id,
        operationId: seed.operations[operationCode]!.id,
        startedAt: first[0],
        endedAt: last[1],
      },
    });
    for (const [startedAt, endedAt] of parts) {
      await t.prisma.shiftSegment.create({
        data: {
          shiftSessionId: session.id,
          employeeId: seed.employees['seamstress']!.id,
          equipmentId: seed.equipment['overlock-01']!.id,
          operationId: seed.operations[operationCode]!.id,
          startedAt,
          endedAt,
        },
      });
    }
    return session;
  };

  const getSummary = async (from: string, to: string) =>
    (
      await api()
        .get('/api/admin/employees/time-tracker-summary')
        .query({ from, to })
        .set('Cookie', cookies['manager']!)
        .expect(200)
    ).body as TimeTrackingSummaryDto;

  const getDrill = async (from: string, to: string) =>
    (
      await api()
        .get(`/api/admin/employees/${seed.employees['seamstress']!.id}/time-tracking`)
        .query({ from, to })
        .set('Cookie', cookies['manager']!)
        .expect(200)
    ).body as TimeTrackingDto;

  const rowOfSeamstress = (body: TimeTrackingSummaryDto) =>
    body.rows.find((r) => r.employeeId === seed.employees['seamstress']!.id)!;

  test('часы — из отрезков; переключение операции внутри смены не задваивает время', async () => {
    // Одна смена 08:00–12:00 с переключением операции в 10:00.
    await seedShift([
      [
        new Date('2026-03-10T08:00:00.000+03:00'),
        new Date('2026-03-10T10:00:00.000+03:00'),
      ],
      [
        new Date('2026-03-10T10:00:00.000+03:00'),
        new Date('2026-03-10T12:00:00.000+03:00'),
      ],
    ]);

    const row = rowOfSeamstress(await getSummary('2026-03-10', '2026-03-10'));
    expect(row.totalMinutes).toBe(240);
    // Сеанс для пользователя — смена, а не её внутренние переключения.
    expect(row.sessionsCount).toBe(1);

    const drill = await getDrill('2026-03-10', '2026-03-10');
    expect(drill.totalMinutes).toBe(240);
    expect(drill.sessions).toHaveLength(1);
    expect(drill.sessions[0]!.durationMinutes).toBe(240);
  });

  test('смена, начатая ДО периода, попадает в период своей частью', async () => {
    // 22:00 предыдущего дня → 02:00 запрашиваемого.
    await seedShift([
      [
        new Date('2026-03-09T22:00:00.000+03:00'),
        new Date('2026-03-10T02:00:00.000+03:00'),
      ],
    ]);

    const row = rowOfSeamstress(await getSummary('2026-03-10', '2026-03-10'));
    // Ровно два часа этих суток, а не четыре и не ноль.
    expect(row.totalMinutes).toBe(120);
  });

  test('смена, ушедшая ЗА конец периода, не засчитывается целиком', async () => {
    await seedShift([
      [
        new Date('2026-03-10T22:00:00.000+03:00'),
        new Date('2026-03-11T02:00:00.000+03:00'),
      ],
    ]);

    const row = rowOfSeamstress(await getSummary('2026-03-10', '2026-03-10'));
    expect(row.totalMinutes).toBe(120);
  });

  test('ночная смена делится между сутками в разбивке «по дням»', async () => {
    await seedShift([
      [
        new Date('2026-03-10T22:00:00.000+03:00'),
        new Date('2026-03-11T02:00:00.000+03:00'),
      ],
    ]);

    const drill = await getDrill('2026-03-10', '2026-03-11');
    const byDay = new Map(drill.byDay.map((d) => [d.day, d.minutes]));
    expect(byDay.get('2026-03-10')).toBe(120);
    expect(byDay.get('2026-03-11')).toBe(120);
    expect(drill.totalMinutes).toBe(240);
  });

  test('часы совпадают с табелем мастера — один расчёт на две вкладки', async () => {
    await seedShift([
      [
        new Date('2026-03-10T08:00:00.000+03:00'),
        new Date('2026-03-10T11:30:00.000+03:00'),
      ],
      [
        new Date('2026-03-10T12:10:00.000+03:00'),
        new Date('2026-03-10T17:00:00.000+03:00'),
      ],
    ]);

    const drill = await getDrill('2026-03-10', '2026-03-10');
    const day = (
      await api()
        .get('/api/master/employee-stats/day')
        .query({
          employeeId: seed.employees['seamstress']!.id,
          date: '2026-03-10',
        })
        .set('Cookie', cookies['manager']!)
        .expect(200)
    ).body as MasterEmployeeDayDto;

    expect(drill.totalMinutes).toBe(day.workedMinutes);
    expect(drill.totalMinutes).toBe(210 + 290);
  });

  test('открытая смена считается до «сейчас» и помечена как идущая', async () => {
    const startedAt = new Date(Date.now() - 90 * 60 * 1000);
    await seedShift([[startedAt, null]]);

    const drill = await getDrill(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(startedAt),
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date()),
    );

    expect(drill.openSessionsCount).toBe(1);
    expect(drill.sessions[0]!.open).toBe(true);
    // ~90 минут: допускаем минуту на время выполнения теста.
    expect(drill.totalMinutes).toBeGreaterThanOrEqual(89);
    expect(drill.totalMinutes).toBeLessThanOrEqual(91);
  });

  test('швея не видит тайм-трекер', async () => {
    await api()
      .get('/api/admin/employees/time-tracker-summary')
      .query({ from: '2026-03-10', to: '2026-03-10' })
      .set('Cookie', cookies['seamstress']!)
      .expect(403);
    await api()
      .get(`/api/admin/employees/${seed.employees['seamstress']!.id}/time-tracking`)
      .query({ from: '2026-03-10', to: '2026-03-10' })
      .set('Cookie', cookies['seamstress']!)
      .expect(403);
  });
});
