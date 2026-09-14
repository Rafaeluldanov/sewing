/**
 * Интеграция «Схема стенда» по заказу — `GET /api/orders/:id/stand`
 * (см. `@sewing/shared/order-stand`, `docs/api.md §11a`).
 *
 * Проверяем не форму DTO, а то, ради чего страница нужна: паспорт
 * двигается по маршруту сканами, и схема это показывает — место
 * паспорта (`place`), счётчики шага и ячейки, подсказка «следующий
 * скан». Стадии считаются той же `bucketOf`, что и монитор, поэтому
 * отдельно сверяем `qtyDone` шага с `/api/shopfloor/state` заказа.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — order stand (схема стенда по заказу)', () => {
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
    };
  });

  async function stand(orderId: string) {
    const r = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/stand`)
      .set('Cookie', cookies.manager);
    expect(r.status).toBe(200);
    return r.body;
  }

  /** Маршрут оверлок → ОТК, заказ на 10 шт M, запуск в производство. */
  async function orderWithRoute(): Promise<string> {
    const code = `STAND-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const tpl = await request(t.app.getHttpServer())
      .post('/api/routes')
      .set('Cookie', cookies.manager)
      .send({
        code,
        name: code,
        steps: [
          { operationId: seed.operations.SEW_OVERLOCK_1.id },
          { operationId: seed.operations.QC.id },
        ],
      })
      .expect(201);
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        routeTemplateId: tpl.body.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    return order.body.id as string;
  }

  async function createPassport(orderId: string, qtyCut: number): Promise<string> {
    const r = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-01',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut,
        cutterId: seed.employees['cutter'].id,
      })
      .expect(201);
    return r.body.id as string;
  }

  test('404 по несуществующему заказу', async () => {
    const r = await request(t.app.getHttpServer())
      .get('/api/orders/nope/stand')
      .set('Cookie', cookies.manager);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('ORDER_NOT_FOUND');
  });

  test('шаги = маршрут заказа, у каждого — рабочее место с QR equipment:{id}', async () => {
    const orderId = await orderWithRoute();
    const s = await stand(orderId);

    expect(s.order.id).toBe(orderId);
    expect(s.steps.map((x: { operationCode: string }) => x.operationCode)).toEqual([
      'SEW_OVERLOCK_1',
      'QC',
    ]);
    // оверлок: станок с ролью SEAMSTRESS и этой операцией в allowed
    expect(s.steps[0].workplace).toMatchObject({
      code: 'overlock-01',
      qrPayload: `equipment:${seed.equipment['overlock-01'].id}`,
    });
    expect(s.steps[1].workplace?.code).toBe('qc-station-01');
    // раскрой — стол с ролью CUTTER, вне маршрута
    expect(s.cutting.workplace?.code).toBe('cutting-table-01');
    expect(s.cutting.passports).toBe(0);
    // стеллаж — все активные ячейки со штатным QR
    expect(s.cells.map((c: { code: string }) => c.code)).toEqual(
      expect.arrayContaining(['A1', 'A2']),
    );
    const a1 = s.cells.find((c: { code: string }) => c.code === 'A1');
    expect(a1.qrPayload).toBe(seed.cells.A1.qrCode);
    expect(s.passports).toEqual([]);
    expect(s.totals).toMatchObject({ qtyPlan: 10, qtyCut: 0 });
  });

  test('паспорт движется: выпуск → ячейка → у швеи → сшито → у ОТК', async () => {
    const orderId = await orderWithRoute();
    const passportId = await createPassport(orderId, 10);

    // 1. выпущен, не размещён
    let s = await stand(orderId);
    expect(s.passports).toHaveLength(1);
    expect(s.passports[0]).toMatchObject({
      id: passportId,
      qrPayload: `passport:${passportId}`,
      sizeCode: 'M',
      place: 'UNPLACED',
      stage: 'CUT',
      stepIndex: 0,
    });
    expect(s.passports[0].nextHint).toMatch(/стеллаж/);
    expect(s.cutting).toMatchObject({ passports: 1, qtyCut: 10, sizesCut: 1, sizesTotal: 1 });
    expect(s.steps[0]).toMatchObject({ qtyInWork: 0, qtyDone: 0 });

    // 2. в ячейке A1 — ячейка считает паспорта ЭТОГО заказа
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);
    s = await stand(orderId);
    expect(s.passports[0]).toMatchObject({ place: 'IN_CELL', cell: { code: 'A1' } });
    expect(s.passports[0].nextHint).toMatch(/швея/);
    expect(s.cells.find((c: { code: string }) => c.code === 'A1')).toMatchObject({
      passports: 1,
      qty: 10,
    });
    // ждёт на первом шаге без исполнителя
    expect(s.steps[0]).toMatchObject({ qtyWaiting: 10, qtyInWork: 0, qtyDone: 0 });

    // 3. швея взяла крой — «в работе», шаг показывает исполнителя
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    s = await stand(orderId);
    expect(s.passports[0]).toMatchObject({ place: 'IN_WORK', stage: 'SEWING', cell: null });
    expect(s.passports[0].employee?.id).toBe(seed.employees['seamstress'].id);
    expect(s.steps[0]).toMatchObject({ qtyInWork: 10, qtyWaiting: 0, qtyDone: 0 });
    expect(s.steps[0].inWork).toHaveLength(1);
    expect(s.cells.find((c: { code: string }) => c.code === 'A1').passports).toBe(0);

    // 4. операция закрыта — буфер «сшито, ждёт ОТК», шаг засчитан
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    s = await stand(orderId);
    expect(s.passports[0]).toMatchObject({ place: 'STEP_DONE', stage: 'SEWING_DONE', stepIndex: 0 });
    expect(s.passports[0].nextHint).toMatch(/ОТК/);
    expect(s.steps[0]).toMatchObject({ qtyInWork: 0, qtyDone: 10, passportsDone: 1 });
    expect(s.steps[1]).toMatchObject({ qtyInWork: 0, qtyDone: 0 });

    // те же цифры, что у монитора цеха по этому заказу
    const state = await request(t.app.getHttpServer())
      .get('/api/shopfloor/state')
      .query({ orderId })
      .set('Cookie', cookies.manager)
      .expect(200);
    const sewingDone = state.body.summary.qtySewingDone;
    expect(sewingDone).toBe(10);

    // 5. ОТК принял сканом — паспорт на шаге ОТК, шаг 1 «прошёл»
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    s = await stand(orderId);
    expect(s.passports[0]).toMatchObject({ place: 'IN_WORK', stage: 'QC', stepIndex: 1 });
    expect(s.steps[0]).toMatchObject({ qtyDone: 10 });
    expect(s.steps[1]).toMatchObject({ qtyInWork: 10 });
  });

  test('заказ без маршрута: шагов нет, паспорта и ячейки всё равно на месте', async () => {
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const passportId = await createPassport(order.body.id, 4);
    const s = await stand(order.body.id);
    expect(s.steps).toEqual([]);
    expect(s.passports[0]).toMatchObject({ id: passportId, place: 'UNPLACED', stepIndex: null });
    expect(s.cells.length).toBeGreaterThan(0);
  });
});
