/**
 * Подкрой (`RecutSession`) не живёт дольше своей смены — регрессия на
 * находку G4-3 Аудита движка расчёта 13.09.2026 (сестра K7 —
 * предохранитель на часы смены, см. `salary.test.ts`).
 *
 * Было: «Завершить смену» подкрой не трогал; забытый таймер тикал до
 * следующей смены, при «Завершить подкрой» в понедельник
 * `workedSeconds = 65 ч`, доплата 19 500 ₽ уходила в ведомость (`RECUT`)
 * и в `recut_rub` документа выпуска для ERP; новый подкрой давал 409.
 *
 * Стало (`RecutService.finish` / `ShiftsService.stop`):
 *   1. закрытие смены завершает активный подкрой тем же моментом;
 *   2. если смена закрыта другим путём (автозакрытие, смена участка),
 *      `complete` режет конец подкроя концом смены;
 *   3. если забыли и смену, и подкрой — работает предохранитель K7:
 *      подкрой не длиннее предела на смену (16 ч по умолчанию).
 *
 * Техника: `startedAt` смены/сегмента/подкроя бэкдейтятся через prisma
 * (в БД `@default(now())`), моменты «пт 18:00» / «пн 09:00» задаются
 * `vi.useFakeTimers({ toFake: ['Date'] })` только на время HTTP-вызова.
 * «Понедельник 09:00» = ближайшее 09:00 UTC в прошлом: пятничные моменты
 * ложатся в один UTC-день (контейнер в UTC, `startOfDay` локальный), а
 * cookie (exp = real now + 1h) остаётся валидной при фейковом now ≤ real.
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { loginAs, refreshAdminCookie, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';
import { OrderFactCostService } from '../../apps/api/src/modules/costs/order-fact-cost.service.js';
import { PassportRealCostService } from '../../apps/api/src/modules/costs/passport-real-cost.service.js';
import { OrderMaterialCostService } from '../../apps/api/src/modules/costs/order-material-cost.service.js';

const H = 3600 * 1000;

/** Ближайшее 09:00 UTC, не позже реального now. */
function anchor09(): Date {
  const d = new Date();
  d.setUTCHours(9, 0, 0, 0);
  if (d.getTime() > Date.now()) d.setTime(d.getTime() - 24 * H);
  return d;
}

describeWithDb('подкрой не переживает смену (G4-3)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    vi.useRealTimers();
    await stopTestApp(t);
  });
  beforeEach(async () => {
    vi.useRealTimers();
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    await refreshAdminCookie(t);
    // `resetDatabase` не трункейтит CompanySettings — политику
    // автозакрытия/предел выставляем явно: выключено, предел по умолчанию.
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        singleton: true,
        shiftAutoCloseTime: null,
        shiftMaxDurationHours: 0,
      },
      update: { shiftAutoCloseTime: null, shiftMaxDurationHours: 0 },
    });
    // Раскройщик — MIXED с почасовой ставкой 300 ₽/ч.
    await t.prisma.employee.update({
      where: { id: seed.employees.cutter.id },
      data: {
        compensationType: 'MIXED',
        salaryRateMode: 'HOURLY',
        salaryPerHour: new Prisma.Decimal(300),
      },
    });
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      cutter: loginAs(t, seed.employees.cutter),
    };
  });

  /** Закрытый ERP-заказ с двумя упакованными паспортами (4 + 6 = 10 годных). */
  async function closedOrder(specId: string, erp: { id: string; number: string }): Promise<string> {
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-09-01T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        patternItemId: specId,
        erpCustomerOrderId: erp.id,
        erpCustomerOrderNumber: erp.number,
      })
      .expect(201);
    const orderId: string = order.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    for (const [i, qty] of [4, 6].entries()) {
      const passport = await request(t.app.getHttpServer())
        .post('/api/passports')
        .set('Cookie', cookies.manager)
        .send({
          orderId,
          sizeId: seed.sizes.M,
          rollNumber: `R-G43-${erp.number}-${i}`,
          cutDate: '2026-09-01T00:00:00.000Z',
          qtyCut: qty,
          cutterId: seed.employees.cutter.id,
        })
        .expect(201);
      await t.prisma.passport.update({
        where: { id: passport.body.id },
        data: { status: 'PACKED', qtyGood: qty },
      });
    }
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    return orderId;
  }

  async function factCost(orderId: string) {
    const passports = await t.prisma.passport.findMany({
      where: { orderId, status: 'PACKED' },
      select: { qtyGood: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma = t.prisma as any;
    return new OrderFactCostService(
      prisma,
      new PassportRealCostService(prisma),
      new OrderMaterialCostService(prisma),
    ).factCostForOrder(
      orderId,
      passports.reduce((sum, p) => sum + (p.qtyGood ?? 0), 0),
    );
  }

  /** Выполнить `fn` при замороженном `Date` = `at` (только Date, таймеры Node живые). */
  async function atMoment<T>(at: Date, fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  }

  /** Смена раскройщика пт 10:00 + подкрой по заказу с пт 16:00 (бэкдейт через prisma). */
  async function fridayShiftWithRecut(orderId: string, fri10: Date, fri16: Date) {
    const eq = seed.equipment['cutting-table-01'];
    const op = seed.operations['CUT_DIVISION'];
    const shift = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.cutter)
      .send({ equipmentId: eq.id, operationId: op.id })
      .expect(201);
    const started = await request(t.app.getHttpServer())
      .post('/api/recut/start')
      .set('Cookie', cookies.cutter)
      .send({ orderId })
      .expect(201);
    expect(started.body.status).toBe('ACTIVE');
    const shiftId: string = shift.body.id;
    const recutId: string = started.body.id;
    await t.prisma.shiftSession.update({ where: { id: shiftId }, data: { startedAt: fri10 } });
    await t.prisma.shiftSegment.updateMany({ where: { shiftSessionId: shiftId }, data: { startedAt: fri10 } });
    await t.prisma.recutSession.update({ where: { id: recutId }, data: { startedAt: fri16 } });
    const linked = await t.prisma.recutSession.findUniqueOrThrow({ where: { id: recutId } });
    expect(linked.shiftSessionId).toBe(shiftId);
    return { shiftId, recutId, eq, op };
  }

  test('«Завершить смену» завершает активный подкрой тем же моментом: 2 ч → 600 ₽, новый подкрой в понедельник доступен', async () => {
    const mon09 = anchor09();
    const fri10 = new Date(mon09.getTime() - 71 * H);
    const fri16 = new Date(mon09.getTime() - 65 * H);
    const fri18 = new Date(mon09.getTime() - 63 * H);

    const spec = await createSpecPattern(t, cookies.manager, {
      materialLines: [
        { name: 'Кулирка чёрная', unit: 'кг', qtyPerUnit: '0.5', materialRole: 'MAIN_FABRIC', colorRule: 'ORDER_COLOR' },
      ],
    });
    const orderA = await closedOrder(spec.id, { id: 'erp-order-10', number: 'ФС-000010' });
    const orderB = await closedOrder(spec.id, { id: 'erp-order-11', number: 'ФС-000011' });
    expect((await factCost(orderA)).recut_rub).toBe(0);

    const { recutId, eq, op } = await fridayShiftWithRecut(orderA, fri10, fri16);

    // Пятница 18:00: «Завершить смену».
    const stopped = await atMoment(fri18, () =>
      request(t.app.getHttpServer())
        .post('/api/shifts/stop')
        .set('Cookie', cookies.cutter)
        .send({})
        .expect(201),
    );
    expect(new Date(stopped.body.endedAt).getTime()).toBe(fri18.getTime());

    // Подкрой завершён концом смены: 2 ч × 300 ₽ = 600 ₽.
    const recut = await t.prisma.recutSession.findUniqueOrThrow({ where: { id: recutId } });
    expect(recut.status).toBe('DONE');
    expect(recut.endedAt?.getTime()).toBe(fri18.getTime());
    expect(recut.workedSeconds).toBe(7200);
    expect(Number(recut.ratePerHour)).toBe(300);
    expect(Number(recut.amount)).toBe(600);

    // Ведомость пятницы: SHIFT_DAY 8 ч = 2 400 ₽, RECUT 2 ч = 600 ₽, тот же день.
    const shiftDay = await t.prisma.salaryEntry.findFirst({
      where: { employeeId: seed.employees.cutter.id, source: 'SHIFT_DAY' },
    });
    const recutEntry = await t.prisma.salaryEntry.findFirst({
      where: { employeeId: seed.employees.cutter.id, source: 'RECUT' },
    });
    expect(shiftDay).not.toBeNull();
    expect(shiftDay!.workedSeconds).toBe(8 * 3600);
    expect(Number(shiftDay!.amount)).toBe(2400);
    expect(recutEntry).not.toBeNull();
    expect(recutEntry!.date.getTime()).toBe(shiftDay!.date.getTime());
    expect(recutEntry!.workedSeconds).toBe(7200);
    expect(Number(recutEntry!.amount)).toBe(600);

    // Себестоимость заказа (то, что уедет в документ выпуска / ERP): 600 ₽, 60 ₽/шт.
    const cost = await factCost(orderA);
    expect(cost.recut_rub).toBe(600);
    expect(cost.per_unit_rub).toBeCloseTo(60, 2);

    // Понедельник 09:00: новая смена, активного подкроя нет, новый стартует.
    await atMoment(mon09, () =>
      request(t.app.getHttpServer())
        .post('/api/shifts/start')
        .set('Cookie', cookies.cutter)
        .send({ equipmentId: eq.id, operationId: op.id })
        .expect(201),
    );
    const active = await request(t.app.getHttpServer())
      .get('/api/recut/active')
      .set('Cookie', cookies.cutter)
      .expect(200);
    expect(active.body?.id ?? null).toBeNull();
    const second = await request(t.app.getHttpServer())
      .post('/api/recut/start')
      .set('Cookie', cookies.cutter)
      .send({ orderId: orderB });
    expect(second.status).toBe(201);
    expect(second.body.status).toBe('ACTIVE');

    // Повторное «Завершить» уже завершённого подкроя — 409, а не вторая оплата.
    const again = await request(t.app.getHttpServer())
      .post(`/api/recut/${recutId}/complete`)
      .set('Cookie', cookies.cutter)
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('RECUT_NOT_ACTIVE');
  });

  test('смена закрыта мимо stop (автозакрытие/смена участка): «Завершить подкрой» в понедельник режется концом смены', async () => {
    const mon09 = anchor09();
    const fri10 = new Date(mon09.getTime() - 71 * H);
    const fri16 = new Date(mon09.getTime() - 65 * H);
    const fri18 = new Date(mon09.getTime() - 63 * H);

    const spec = await createSpecPattern(t, cookies.manager, {
      materialLines: [
        { name: 'Кулирка чёрная', unit: 'кг', qtyPerUnit: '0.5', materialRole: 'MAIN_FABRIC', colorRule: 'ORDER_COLOR' },
      ],
    });
    const orderA = await closedOrder(spec.id, { id: 'erp-order-12', number: 'ФС-000012' });
    const { shiftId, recutId } = await fridayShiftWithRecut(orderA, fri10, fri16);

    // Смену закрыл не `stop` (как автозакрытие или `switchWorkplace`):
    // подкрой остаётся ACTIVE — таймер на доске тикает до понедельника.
    await t.prisma.shiftSession.update({ where: { id: shiftId }, data: { endedAt: fri18 } });
    const stillActive = await t.prisma.recutSession.findUniqueOrThrow({ where: { id: recutId } });
    expect(stillActive.status).toBe('ACTIVE');

    const done = await atMoment(mon09, () =>
      request(t.app.getHttpServer())
        .post(`/api/recut/${recutId}/complete`)
        .set('Cookie', cookies.cutter)
        .send({})
        .expect(201),
    );
    expect(done.body.status).toBe('DONE');
    expect(new Date(done.body.endedAt).getTime()).toBe(fri18.getTime());
    expect(done.body.workedSeconds).toBe(7200);
    expect(done.body.amount).toBe(600);

    const recutEntry = await t.prisma.salaryEntry.findFirst({
      where: { employeeId: seed.employees.cutter.id, source: 'RECUT' },
    });
    expect(recutEntry!.workedSeconds).toBe(7200);
    expect(Number(recutEntry!.amount)).toBe(600);
    expect((await factCost(orderA)).recut_rub).toBe(600);
  });

  test('забыли и смену, и подкрой: stop в понедельник — часы обоих не выше предела (16 ч), не 65 ч', async () => {
    const mon09 = anchor09();
    const fri10 = new Date(mon09.getTime() - 71 * H);
    const fri16 = new Date(mon09.getTime() - 65 * H);

    const spec = await createSpecPattern(t, cookies.manager, {
      materialLines: [
        { name: 'Кулирка чёрная', unit: 'кг', qtyPerUnit: '0.5', materialRole: 'MAIN_FABRIC', colorRule: 'ORDER_COLOR' },
      ],
    });
    const orderA = await closedOrder(spec.id, { id: 'erp-order-13', number: 'ФС-000013' });
    const { recutId } = await fridayShiftWithRecut(orderA, fri10, fri16);

    const stopped = await atMoment(mon09, () =>
      request(t.app.getHttpServer())
        .post('/api/shifts/stop')
        .set('Cookie', cookies.cutter)
        .send({})
        .expect(201),
    );
    expect(new Date(stopped.body.endedAt).getTime()).toBe(mon09.getTime());

    // Предохранитель K7 (`shiftMaxDurationHours = 0` → 16 ч): смена 71 ч и
    // подкрой 65 ч в деньгах — не больше 16 ч = 4 800 ₽ каждый. Сама
    // `ShiftSession` хранит настоящий `endedAt` (табель мастера).
    const cap = 16 * 3600;
    const recut = await t.prisma.recutSession.findUniqueOrThrow({ where: { id: recutId } });
    expect(recut.status).toBe('DONE');
    expect(recut.endedAt?.getTime()).toBe(mon09.getTime());
    expect(recut.workedSeconds).toBe(cap);
    expect(Number(recut.amount)).toBe(4800);

    const shiftDay = await t.prisma.salaryEntry.findFirst({
      where: { employeeId: seed.employees.cutter.id, source: 'SHIFT_DAY' },
    });
    expect(shiftDay!.workedSeconds).toBe(cap);
    expect(Number(shiftDay!.amount)).toBe(4800);
    const recutEntry = await t.prisma.salaryEntry.findFirst({
      where: { employeeId: seed.employees.cutter.id, source: 'RECUT' },
    });
    expect(recutEntry!.workedSeconds).toBe(cap);
    expect(Number(recutEntry!.amount)).toBe(4800);
    expect((await factCost(orderA)).recut_rub).toBe(4800);
  });
});
