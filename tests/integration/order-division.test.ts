/**
 * Integration-тесты подразделения заказа (`Order.companyDivisionId`)
 * и связанного фильтра большого экрана
 * `/api/shopfloor/display?divisionCode=…`.
 *
 * Покрытие:
 *   1. Создание заказа с `companyDivisionId` сохраняет привязку и
 *      отдаёт краткие реквизиты `companyDivision` в DTO.
 *   2. Создание заказа без `companyDivisionId` оставляет привязку
 *      пустой (`null`) — earnings-helper для отсутствующего кода
 *      даёт безопасный B2B-default.
 *   3. PATCH /api/orders/:id меняет `companyDivisionId` пока заказ
 *      DRAFT.
 *   4. POST /api/orders с несуществующим `companyDivisionId` →
 *      400 `COMPANY_DIVISION_NOT_FOUND`.
 *   5. `/api/shopfloor/display?divisionCode=MARKETPLACE` отдаёт
 *      только паспорта marketplace-заказов; OTHER-заказы при этом
 *      отрезаются.
 *   6. `/api/shopfloor/display?divisionCode=OTHER` зеркально не
 *      возвращает marketplace-партии.
 *   7. Без параметра `divisionCode` поведение прежнее: видим оба
 *      заказа.
 *   8. Audit `ORDER_CREATED` содержит `companyDivisionId` /
 *      `companyDivisionCode`.
 *
 * Контракт описан в `docs/api.md §13`, доменная роль поля — в
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

  test('POST /api/orders сохраняет companyDivisionId=MARKETPLACE', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.companyDivisionId).toBe(
      seed.companyDivisions.MARKETPLACE.id,
    );
    expect(res.body.companyDivision).toMatchObject({
      id: seed.companyDivisions.MARKETPLACE.id,
      code: 'MARKETPLACE',
      name: 'Маркетплейс',
    });

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${res.body.id}`)
      .set('Cookie', cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.companyDivisionId).toBe(
      seed.companyDivisions.MARKETPLACE.id,
    );
  });

  test('POST /api/orders без companyDivisionId → companyDivisionId=null', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.S, qtyPlan: 1 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.companyDivisionId).toBeNull();
    expect(res.body.companyDivision).toBeNull();
  });

  test('PATCH /api/orders/:id меняет companyDivisionId пока заказ DRAFT', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        companyDivisionId: seed.companyDivisions.OTHER.id,
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
  });

  test('POST /api/orders с несуществующим companyDivisionId → 400 COMPANY_DIVISION_NOT_FOUND', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        companyDivisionId: 'no-such-division-id',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('COMPANY_DIVISION_NOT_FOUND');
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
    expect(payload.companyDivisionId).toBe(
      seed.companyDivisions.MARKETPLACE.id,
    );
    expect(payload.companyDivisionCode).toBe('MARKETPLACE');
  });

  // ---------------------------------------------------------------------------
  // SHOPFLOOR DISPLAY: фильтр по divisionCode
  // ---------------------------------------------------------------------------

  test('GET /api/shopfloor/display?divisionCode=… фильтрует по подразделению заказа', async () => {
    const today = new Date();

    const orderMp = await t.prisma.order.create({
      data: {
        number: 'O-DIV-MP',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
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
        companyDivisionId: seed.companyDivisions.OTHER.id,
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
      .get('/api/shopfloor/display?divisionCode=MARKETPLACE')
      .set('Cookie', cookie);
    expect(mp.status).toBe(200);
    expect(mp.body.colors.map((c: { colorKey: string }) => c.colorKey)).toEqual([
      'black',
    ]);
    expect(mp.body.kpi.waiting).toBe(4);
    expect(mp.body.totals.qtyCut).toBe(4);

    // 2) С фильтром OTHER — только белый (7 шт), чёрного нет.
    const other = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display?divisionCode=OTHER')
      .set('Cookie', cookie);
    expect(other.status).toBe(200);
    expect(other.body.colors.map((c: { colorKey: string }) => c.colorKey)).toEqual([
      'white',
    ]);
    expect(other.body.kpi.waiting).toBe(7);
    expect(other.body.totals.qtyCut).toBe(7);

    // 3) Без параметра — оба, как раньше (backward-compat).
    const all = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(all.status).toBe(200);
    expect(
      all.body.colors
        .map((c: { colorKey: string }) => c.colorKey)
        .sort(),
    ).toEqual(['black', 'white']);
    expect(all.body.kpi.waiting).toBe(11);
    expect(all.body.totals.qtyCut).toBe(11);
  });
});
