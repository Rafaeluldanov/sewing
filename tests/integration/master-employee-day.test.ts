/**
 * Integration-тесты «Табель дня» в кабинете мастера (12.08.2026):
 *
 *   - отрезки смены `ShiftSegment` (`apps/api/src/modules/shifts/shift-segments.ts`),
 *     которые пишут `ShiftsService.start/switchOperation/stop`,
 *     `MeService.switchWorkplace` и техническая смена мастера;
 *   - `GET /api/master/employee-stats/day`
 *     (`apps/api/src/modules/master-employee-stats/*`).
 *
 * Ключевые инварианты, ради которых тесты и написаны:
 *
 *   1. Переключение операции ВНУТРИ смены режет её на отрезки. Без
 *      этого всё время смены доставалось последней операции: смена
 *      `switchOperation` перезаписывает `operationId` у активной сессии,
 *      и от предыдущей операции не оставалось следа.
 *   2. Смена участка (`switch-workplace`) закрывает отрезок. Она НЕ
 *      идёт через `ShiftsService.stop`, поэтому без отдельной врезки
 *      отрезок остался бы открытым навсегда и «где был» показывало бы
 *      старый участок до конца времён.
 *   3. У смены не более ОДНОГО открытого отрезка (partial unique index
 *      `shift_segment_open_session_uniq`).
 *   4. Сутки табеля — МОСКОВСКИЕ: работа в 00:30 МСК попадает в текущий
 *      день, а не в предыдущий (UTC-окно уводило её на 3 часа назад).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import type { MasterEmployeeDayDto, MasterEmployeeStatsDto } from '@sewing/shared';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — табель дня (кабинет мастера)', () => {
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
      master: loginAs(t, seed.employees['master']!),
      seamstress: loginAs(t, seed.employees['seamstress']!),
    };
  });

  const api = () => request(t.app.getHttpServer());

  /** Московские сутки `YYYY-MM-DD` для Date. */
  const moscowDay = (d: Date = new Date()): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);

  const startShift = (operationCode: 'SEW_OVERLOCK_1' | 'SEW_OVERLOCK_2') =>
    api()
      .post('/api/shifts/start')
      .set('Cookie', cookies['seamstress']!)
      .send({
        equipmentId: seed.equipment['overlock-01']!.id,
        operationId: seed.operations[operationCode]!.id,
      })
      .expect(201);

  // =========================================================================
  // Ведение отрезков
  // =========================================================================

  test('старт смены открывает отрезок, границы совпадают со сменой', async () => {
    await startShift('SEW_OVERLOCK_1');

    const session = await t.prisma.shiftSession.findFirstOrThrow({
      where: { employeeId: seed.employees['seamstress']!.id },
    });
    const segments = await t.prisma.shiftSegment.findMany({
      where: { shiftSessionId: session.id },
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]!.operationId).toBe(seed.operations.SEW_OVERLOCK_1!.id);
    expect(segments[0]!.equipmentId).toBe(seed.equipment['overlock-01']!.id);
    expect(segments[0]!.endedAt).toBeNull();
    // Ровно `startedAt` смены: иначе присутствие не сходилось бы с
    // суммой отрезков.
    expect(segments[0]!.startedAt.getTime()).toBe(session.startedAt.getTime());
  });

  test('смена операции внутри смены режет её на два отрезка встык', async () => {
    await startShift('SEW_OVERLOCK_1');
    await api()
      .post('/api/shifts/switch-operation')
      .set('Cookie', cookies['seamstress']!)
      .send({ operationId: seed.operations.SEW_OVERLOCK_2!.id })
      .expect(201);

    const segments = await t.prisma.shiftSegment.findMany({
      where: { employeeId: seed.employees['seamstress']!.id },
      orderBy: { startedAt: 'asc' },
    });

    expect(segments).toHaveLength(2);
    expect(segments[0]!.operationId).toBe(seed.operations.SEW_OVERLOCK_1!.id);
    expect(segments[0]!.endedAt).not.toBeNull();
    expect(segments[1]!.operationId).toBe(seed.operations.SEW_OVERLOCK_2!.id);
    expect(segments[1]!.endedAt).toBeNull();
    // Встык, без «дыры»: конец первого = начало второго.
    expect(segments[0]!.endedAt!.getTime()).toBe(
      segments[1]!.startedAt.getTime(),
    );
    // Сама смена по-прежнему одна — режем только отрезки.
    expect(
      await t.prisma.shiftSession.count({
        where: { employeeId: seed.employees['seamstress']!.id },
      }),
    ).toBe(1);
  });

  test('стоп смены закрывает отрезок концом смены', async () => {
    await startShift('SEW_OVERLOCK_1');
    await api()
      .post('/api/shifts/stop')
      .set('Cookie', cookies['seamstress']!)
      .send({})
      .expect(201);

    const session = await t.prisma.shiftSession.findFirstOrThrow({
      where: { employeeId: seed.employees['seamstress']!.id },
    });
    const segment = await t.prisma.shiftSegment.findFirstOrThrow({
      where: { shiftSessionId: session.id },
    });

    expect(segment.endedAt).not.toBeNull();
    expect(segment.endedAt!.getTime()).toBe(session.endedAt!.getTime());
    // Открытых отрезков не осталось — иначе табель считал бы время до
    // «сейчас» вечно.
    expect(
      await t.prisma.shiftSegment.count({
        where: {
          employeeId: seed.employees['seamstress']!.id,
          endedAt: null,
        },
      }),
    ).toBe(0);
  });

  test('переход на другой участок закрывает отрезок (не через stop)', async () => {
    // Швея должна иметь второй участок, иначе переход запрещён.
    await t.prisma.employee.update({
      where: { id: seed.employees['seamstress']!.id },
      data: { roles: ['SEAMSTRESS', 'QC'] },
    });
    await startShift('SEW_OVERLOCK_1');

    await api()
      .post('/api/me/switch-workplace')
      .set('Cookie', cookies['seamstress']!)
      .send({ role: 'QC' })
      .expect(200);

    expect(
      await t.prisma.shiftSegment.count({
        where: {
          employeeId: seed.employees['seamstress']!.id,
          endedAt: null,
        },
      }),
    ).toBe(0);
  });

  // =========================================================================
  // Ручка табеля
  // =========================================================================

  test('табель дня: участки, отрезки и загрузка', async () => {
    await startShift('SEW_OVERLOCK_1');
    await api()
      .post('/api/shifts/switch-operation')
      .set('Cookie', cookies['seamstress']!)
      .send({ operationId: seed.operations.SEW_OVERLOCK_2!.id })
      .expect(201);

    const res = await api()
      .get('/api/master/employee-stats/day')
      .query({
        employeeId: seed.employees['seamstress']!.id,
        from: moscowDay(),
        to: moscowDay(),
      })
      .set('Cookie', cookies['master']!)
      .expect(200);
    const body = res.body as MasterEmployeeDayDto;

    expect(body.employeeId).toBe(seed.employees['seamstress']!.id);
    expect(body.segments).toHaveLength(2);
    expect(body.transitions).toBe(1);
    expect(body.hasOpenSegment).toBe(true);
    // Оба отрезка на одном рабочем месте — «где был» их складывает.
    expect(body.places).toHaveLength(1);
    expect(body.places[0]!.category).toBe('SEWING');
    expect(body.places[0]!.operations).toBe(2);
    // Пауз не было: отрезки идут встык.
    expect(body.breaks).toBe(0);
    expect(body.idleMinutes).toBe(0);
    // Обе операции — строками, даже без выработки.
    expect(body.operations.map((o) => o.operationCode).sort()).toEqual([
      'SEW_OVERLOCK_1',
      'SEW_OVERLOCK_2',
    ]);
  });

  test('табель за день без смен — нули, а не 404', async () => {
    const res = await api()
      .get('/api/master/employee-stats/day')
      .query({
        employeeId: seed.employees['seamstress']!.id,
        from: '2020-01-01',
        to: '2020-01-01',
      })
      .set('Cookie', cookies['master']!)
      .expect(200);
    const body = res.body as MasterEmployeeDayDto;

    expect(body.segments).toHaveLength(0);
    expect(body.workedMinutes).toBe(0);
    expect(body.presenceMinutes).toBe(0);
    expect(body.utilization).toBeNull();
    expect(body.employeeName).toBe(seed.employees['seamstress']!.fullName);
  });

  test('сотрудник на смене без выработки виден в списке нулевой строкой', async () => {
    await startShift('SEW_OVERLOCK_1');

    const day = moscowDay();
    const res = await api()
      .get('/api/master/employee-stats')
      .query({ from: day, to: day })
      .set('Cookie', cookies['master']!)
      .expect(200);
    const body = res.body as MasterEmployeeStatsDto;

    const row = body.rows.find(
      (r) => r.employeeId === seed.employees['seamstress']!.id,
    );
    expect(row).toBeDefined();
    expect(row!.totalQty).toBe(0);
    expect(row!.hasOpenSegment).toBe(true);
    // Мини-лента заполняется только для одних суток.
    expect(row!.ribbon.length).toBeGreaterThan(0);
    expect(row!.ribbon[0]!.category).toBe('SEWING');
  });

  test('мини-ленты нет, если период больше суток', async () => {
    await startShift('SEW_OVERLOCK_1');

    const today = moscowDay();
    const yesterday = moscowDay(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const res = await api()
      .get('/api/master/employee-stats')
      .query({ from: yesterday, to: today })
      .set('Cookie', cookies['master']!)
      .expect(200);
    const body = res.body as MasterEmployeeStatsDto;

    const row = body.rows.find(
      (r) => r.employeeId === seed.employees['seamstress']!.id,
    );
    expect(row).toBeDefined();
    expect(row!.ribbon).toHaveLength(0);
    expect(row!.workedMinutes).toBeGreaterThanOrEqual(0);
  });

  test('сутки табеля московские: работа в 00:30 МСК остаётся в своём дне', async () => {
    // 00:30 МСК = 21:30 UTC ПРЕДЫДУЩИХ суток — ровно тот случай, на
    // котором UTC-окно уводило работу в прошлый день.
    const day = '2026-03-10';
    const startedAt = new Date('2026-03-10T00:30:00.000+03:00');
    const endedAt = new Date('2026-03-10T02:00:00.000+03:00');
    const session = await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees['seamstress']!.id,
        equipmentId: seed.equipment['overlock-01']!.id,
        operationId: seed.operations.SEW_OVERLOCK_1!.id,
        startedAt,
        endedAt,
      },
    });
    await t.prisma.shiftSegment.create({
      data: {
        shiftSessionId: session.id,
        employeeId: seed.employees['seamstress']!.id,
        equipmentId: seed.equipment['overlock-01']!.id,
        operationId: seed.operations.SEW_OVERLOCK_1!.id,
        startedAt,
        endedAt,
      },
    });

    const res = await api()
      .get('/api/master/employee-stats/day')
      .query({
        employeeId: seed.employees['seamstress']!.id,
        from: day,
        to: day,
      })
      .set('Cookie', cookies['master']!)
      .expect(200);
    const body = res.body as MasterEmployeeDayDto;

    expect(body.segments).toHaveLength(1);
    expect(body.workedMinutes).toBe(90);

    // В предыдущих сутках этой работы быть не должно.
    const prev = await api()
      .get('/api/master/employee-stats/day')
      .query({
        employeeId: seed.employees['seamstress']!.id,
        from: '2026-03-09',
        to: '2026-03-09',
      })
      .set('Cookie', cookies['master']!)
      .expect(200);
    expect((prev.body as MasterEmployeeDayDto).segments).toHaveLength(0);
  });

  test('отрезок через полночь обрезается границами суток', async () => {
    const startedAt = new Date('2026-03-10T22:00:00.000+03:00');
    const endedAt = new Date('2026-03-11T02:00:00.000+03:00');
    const session = await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees['seamstress']!.id,
        equipmentId: seed.equipment['overlock-01']!.id,
        operationId: seed.operations.SEW_OVERLOCK_1!.id,
        startedAt,
        endedAt,
      },
    });
    await t.prisma.shiftSegment.create({
      data: {
        shiftSessionId: session.id,
        employeeId: seed.employees['seamstress']!.id,
        equipmentId: seed.equipment['overlock-01']!.id,
        operationId: seed.operations.SEW_OVERLOCK_1!.id,
        startedAt,
        endedAt,
      },
    });

    const first = await api()
      .get('/api/master/employee-stats/day')
      .query({
        employeeId: seed.employees['seamstress']!.id,
        from: '2026-03-10',
        to: '2026-03-10',
      })
      .set('Cookie', cookies['master']!)
      .expect(200);
    const second = await api()
      .get('/api/master/employee-stats/day')
      .query({
        employeeId: seed.employees['seamstress']!.id,
        from: '2026-03-11',
        to: '2026-03-11',
      })
      .set('Cookie', cookies['master']!)
      .expect(200);

    // 22:00–24:00 в первый день, 00:00–02:00 во второй: часы не
    // задваиваются и не теряются.
    expect((first.body as MasterEmployeeDayDto).workedMinutes).toBe(120);
    expect((second.body as MasterEmployeeDayDto).workedMinutes).toBe(120);
  });

  test('период больше суток: часы по дням, без событий в отрезках', async () => {
    // Три дня подряд по два часа.
    for (const day of ['2026-03-10', '2026-03-11', '2026-03-12']) {
      const startedAt = new Date(`${day}T09:00:00.000+03:00`);
      const endedAt = new Date(`${day}T11:00:00.000+03:00`);
      const session = await t.prisma.shiftSession.create({
        data: {
          employeeId: seed.employees['seamstress']!.id,
          equipmentId: seed.equipment['overlock-01']!.id,
          operationId: seed.operations.SEW_OVERLOCK_1!.id,
          startedAt,
          endedAt,
        },
      });
      await t.prisma.shiftSegment.create({
        data: {
          shiftSessionId: session.id,
          employeeId: seed.employees['seamstress']!.id,
          equipmentId: seed.equipment['overlock-01']!.id,
          operationId: seed.operations.SEW_OVERLOCK_1!.id,
          startedAt,
          endedAt,
        },
      });
    }

    const res = await api()
      .get('/api/master/employee-stats/day')
      .query({
        employeeId: seed.employees['seamstress']!.id,
        from: '2026-03-10',
        to: '2026-03-12',
      })
      .set('Cookie', cookies['master']!)
      .expect(200);
    const body = res.body as MasterEmployeeDayDto;

    expect(body.workedMinutes).toBe(360);
    expect(body.byDay).toHaveLength(3);
    expect(body.byDay.map((d) => d.day)).toEqual([
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
    ]);
    expect(body.byDay.every((d) => d.minutes === 120)).toBe(true);
    // События в отрезках — только для одних суток: за период их сотни,
    // а ленты дня на неделе UI и не показывает.
    expect(body.segments.every((s) => s.events.length === 0)).toBe(true);
  });

  test('за одни сутки отрезок несёт события с номерами паспортов', async () => {
    const startedAt = new Date('2026-03-10T09:00:00.000+03:00');
    const endedAt = new Date('2026-03-10T11:00:00.000+03:00');
    const session = await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees['seamstress']!.id,
        equipmentId: seed.equipment['overlock-01']!.id,
        operationId: seed.operations.SEW_OVERLOCK_1!.id,
        startedAt,
        endedAt,
      },
    });
    await t.prisma.shiftSegment.create({
      data: {
        shiftSessionId: session.id,
        employeeId: seed.employees['seamstress']!.id,
        equipmentId: seed.equipment['overlock-01']!.id,
        operationId: seed.operations.SEW_OVERLOCK_1!.id,
        startedAt,
        endedAt,
      },
    });
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DAY-1',
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M!,
            qtyPlan: 20,
          },
        },
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: 'P-DAY-1',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M!,
        color: seed.product.color,
        rollNumber: 'R-DAY',
        cutDate: startedAt,
        qtyPlan: 20,
        qtyCut: 20,
        qtyGood: 20,
        qrCode: `passport:day-${Date.now()}`,
        cutterId: seed.employees['cutter']!.id,
        creatorId: seed.employees['cutter']!.id,
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        employeeId: seed.employees['seamstress']!.id,
        operationId: seed.operations.SEW_OVERLOCK_1!.id,
        type: 'OPERATION_FINISHED',
        qty: 20,
        createdAt: new Date('2026-03-10T10:30:00.000+03:00'),
      },
    });

    const res = await api()
      .get('/api/master/employee-stats/day')
      .query({
        employeeId: seed.employees['seamstress']!.id,
        from: '2026-03-10',
        to: '2026-03-10',
      })
      .set('Cookie', cookies['master']!)
      .expect(200);
    const body = res.body as MasterEmployeeDayDto;

    expect(body.segments).toHaveLength(1);
    const events = body.segments[0]!.events;
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('OPERATION_FINISHED');
    expect(events[0]!.passportNumber).toBe('P-DAY-1');
    expect(events[0]!.qty).toBe(20);
  });

  test('швея не видит чужой табель', async () => {
    await api()
      .get('/api/master/employee-stats/day')
      .query({
        employeeId: seed.employees['master']!.id,
        from: moscowDay(),
        to: moscowDay(),
      })
      .set('Cookie', cookies['seamstress']!)
      .expect(403);
  });
});
