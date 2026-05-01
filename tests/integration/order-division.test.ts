/**
 * Integration-тесты подразделения заказа (`OrderDivision`) и связанного
 * фильтра большого экрана `/api/shopfloor/display?division=…`.
 *
 * Покрытие соответствует п. 9 ТЗ «MVP MARKETPLACE display screen»:
 *   1. Создание заказа с `division=MARKETPLACE` сохраняет значение.
 *   2. Редактирование DRAFT-заказа меняет division.
 *   3. `/api/shopfloor/display?division=MARKETPLACE` отдаёт только
 *      паспорта marketplace-заказов; OTHER-заказы при этом отрезаются.
 *   4. `/api/shopfloor/display?division=OTHER` зеркально не возвращает
 *      marketplace-партии.
 *   5. Без параметра `division` поведение прежнее: видим оба заказа
 *      (backward-compatibility со существующими экранами).
 *
 * Контракт описан в `docs/api.md §11`, доменная роль поля — в
 * `docs/domain.md §«Подразделения заказа»`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — order division & shopfloor display filter', () => {
  let t: TestApp;
  let seed: SeedResult;
  // Cookie от shop-chief'а из seed'а (роль SHOP_MANAGER): системный
  // admin из `startTestApp` теряется на первом `resetDatabase`, а
  // seed-сотрудник пересоздаётся в каждом `beforeEach` — cookie
  // всегда валиден. Тот же приём, что в `tests/integration/shopfloor-display.test.ts`.
  let cookie: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookie = loginAs(t, seed.employees['shop-chief']);
  });

  // ---------------------------------------------------------------------------
  // ORDERS API: создание / редактирование с подразделением
  // ---------------------------------------------------------------------------

  test('POST /api/orders сохраняет division=MARKETPLACE', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set("Cookie", cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        division: 'MARKETPLACE',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.division).toBe('MARKETPLACE');

    // Сразу проверяем, что list/getOne возвращают то же значение —
    // чтобы регрессия в маппере не пропустила division мимо UI.
    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${res.body.id}`)
      .set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.division).toBe('MARKETPLACE');
  });

  test('POST /api/orders без division → дефолт OTHER (backward-compatible)', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set("Cookie", cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.S, qtyPlan: 1 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.division).toBe('OTHER');
  });

  test('PATCH /api/orders/:id меняет division пока заказ DRAFT', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set("Cookie", cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        division: 'OTHER',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      });
    expect(created.status).toBe(201);

    const updated = await request(t.app.getHttpServer())
      .patch(`/api/orders/${created.body.id}`)
      .set("Cookie", cookie)
      .send({ division: 'MARKETPLACE' });
    expect(updated.status).toBe(200);
    expect(updated.body.division).toBe('MARKETPLACE');
  });

  // ---------------------------------------------------------------------------
  // PHASE 1 «CompanyDivision как master-справочник»
  // (см. `docs/domain.md §«Подразделения заказа»`)
  // ---------------------------------------------------------------------------

  test('POST /api/orders с legacy division=MARKETPLACE заполняет companyDivisionId по соответствию code', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        division: 'MARKETPLACE',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 3 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.division).toBe('MARKETPLACE');
    // PHASE 1: backend синхронно подкладывает FK по `code`.
    expect(res.body.companyDivisionId).toBe(
      seed.companyDivisions.MARKETPLACE.id,
    );
    expect(res.body.companyDivision).toMatchObject({
      id: seed.companyDivisions.MARKETPLACE.id,
      code: 'MARKETPLACE',
      name: 'Маркетплейс',
    });
  });

  test('POST /api/orders с companyDivisionId синхронизирует legacy division по code', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.division).toBe('MARKETPLACE');
    expect(res.body.companyDivisionId).toBe(
      seed.companyDivisions.MARKETPLACE.id,
    );
  });

  test('PATCH /api/orders/:id меняет companyDivisionId и синхронизирует legacy division', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        division: 'OTHER',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      });
    expect(created.status).toBe(201);
    expect(created.body.companyDivisionId).toBe(
      seed.companyDivisions.OTHER.id,
    );

    const updated = await request(t.app.getHttpServer())
      .patch(`/api/orders/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ companyDivisionId: seed.companyDivisions.MARKETPLACE.id });
    expect(updated.status).toBe(200);
    expect(updated.body.companyDivisionId).toBe(
      seed.companyDivisions.MARKETPLACE.id,
    );
    // PHASE 1: legacy enum синхронизируется по `code`.
    expect(updated.body.division).toBe('MARKETPLACE');
  });

  test('GET /api/shopfloor/display?divisionCode=MARKETPLACE фильтрует так же, как legacy ?division=', async () => {
    const today = new Date();
    const orderMp = await t.prisma.order.create({
      data: {
        number: 'O-DIV-CD-MP',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        division: 'MARKETPLACE',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.S, qtyPlan: 5 },
          ],
        },
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-DIV-CD-MP-S',
        qrCode: 'passport:div-cd-mp-s',
        orderId: orderMp.id,
        productId: seed.product.id,
        sizeId: seed.sizes.S,
        color: 'Чёрный',
        rollNumber: 'R-CD-MP',
        cutDate: today,
        qtyPlan: 5,
        qtyCut: 5,
        qtyGood: 5,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'CREATED',
      },
    });

    const byCode = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display?divisionCode=MARKETPLACE')
      .set('Cookie', cookie);
    expect(byCode.status).toBe(200);
    expect(byCode.body.kpi.waiting).toBe(5);

    // Legacy URL продолжает работать как раньше.
    const byLegacy = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display?division=MARKETPLACE')
      .set('Cookie', cookie);
    expect(byLegacy.status).toBe(200);
    expect(byLegacy.body.kpi.waiting).toBe(5);
  });

  test('audit ORDER_CREATED содержит companyDivisionId и companyDivisionCode', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      });
    expect(res.status).toBe(201);

    const audit = await t.prisma.auditLog.findFirst({
      where: {
        entityType: 'ORDER',
        entityId: res.body.id,
        event: 'ORDER_CREATED',
      },
    });
    expect(audit).not.toBeNull();
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.division).toBe('MARKETPLACE');
    expect(payload.companyDivisionId).toBe(
      seed.companyDivisions.MARKETPLACE.id,
    );
    expect(payload.companyDivisionCode).toBe('MARKETPLACE');
  });

  // ---------------------------------------------------------------------------
  // SHOPFLOOR DISPLAY: фильтр по division
  // ---------------------------------------------------------------------------

  test('GET /api/shopfloor/display?division=… фильтрует по подразделению заказа', async () => {
    const today = new Date();

    const orderMp = await t.prisma.order.create({
      data: {
        number: 'O-DIV-MP',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        division: 'MARKETPLACE',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.S, qtyPlan: 4 },
          ],
        },
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-DIV-MP-S',
        qrCode: 'passport:div-mp-s',
        orderId: orderMp.id,
        productId: seed.product.id,
        sizeId: seed.sizes.S,
        color: 'Чёрный',
        rollNumber: 'R-MP',
        cutDate: today,
        qtyPlan: 4,
        qtyCut: 4,
        qtyGood: 4,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'CREATED',
      },
    });

    const orderOther = await t.prisma.order.create({
      data: {
        number: 'O-DIV-OTH',
        orderDate: today,
        color: 'Белый',
        status: 'IN_PRODUCTION',
        division: 'OTHER',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 7 },
          ],
        },
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-DIV-OTH-M',
        qrCode: 'passport:div-oth-m',
        orderId: orderOther.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Белый',
        rollNumber: 'R-OTH',
        cutDate: today,
        qtyPlan: 7,
        qtyCut: 7,
        qtyGood: 7,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'CREATED',
      },
    });

    // 1) С фильтром MARKETPLACE — только чёрный (4 шт), белого нет.
    const mp = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display?division=MARKETPLACE')
      .set("Cookie", cookie);
    expect(mp.status).toBe(200);
    expect(mp.body.colors.map((c: { colorKey: string }) => c.colorKey)).toEqual([
      'black',
    ]);
    expect(mp.body.kpi.waiting).toBe(4);
    expect(mp.body.totals.qtyCut).toBe(4);

    // 2) С фильтром OTHER — только белый (7 шт), чёрного нет.
    const other = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display?division=OTHER')
      .set("Cookie", cookie);
    expect(other.status).toBe(200);
    expect(other.body.colors.map((c: { colorKey: string }) => c.colorKey)).toEqual([
      'white',
    ]);
    expect(other.body.kpi.waiting).toBe(7);
    expect(other.body.totals.qtyCut).toBe(7);

    // 3) Без параметра — оба, как раньше (backward-compat).
    const all = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set("Cookie", cookie);
    expect(all.status).toBe(200);
    expect(
      all.body.colors
        .map((c: { colorKey: string }) => c.colorKey)
        .sort(),
    ).toEqual(['black', 'white']);
    expect(all.body.kpi.waiting).toBe(11);
    expect(all.body.totals.qtyCut).toBe(11);
  });

  test('невалидный division → 400 (Zod validation)', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display?division=NOT_A_VALUE')
      .set("Cookie", cookie);
    expect(res.status).toBe(400);
  });
});
