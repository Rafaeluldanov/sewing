/**
 * Integration-тесты read-only API склада
 * (`GET /api/stock/balances`, `GET /api/stock/movements`,
 *  см. `apps/api/src/modules/stock/stock.controller.ts`,
 *  `apps/api/src/modules/stock/stock.service.ts::listBalances` /
 *  `listMovements`,
 *  `docs/api.md §«26a. Stock (read-only)»`,
 *  `docs/current-state.md §«Read-only API склада»`).
 *
 * Покрытие (номера совпадают с ТЗ §8 «Tests»):
 *
 *   1. GET /api/stock/balances возвращает остатки.
 *   2. GET /api/stock/balances фильтрует по orderId.
 *   3. GET /api/stock/balances фильтрует positiveOnly.
 *   4. GET /api/stock/balances фильтрует negativeOnly.
 *   5. GET /api/stock/balances 400 при positiveOnly + negativeOnly.
 *   6. GET /api/stock/movements возвращает движения.
 *   7. GET /api/stock/movements фильтрует по orderId.
 *   8. GET /api/stock/movements фильтрует по type.
 *   9. GET /api/stock/movements фильтрует по direction.
 *  10. GET /api/stock/movements фильтрует по дате (from/to).
 *  11. Не-привилегированная роль (SEAMSTRESS) получает 403.
 *  12. ADMIN и SHOP_MANAGER могут вызывать оба эндпоинта.
 *  13. sourceKey не отдаётся в response.
 *
 * Без `TEST_DATABASE_URL` `describeWithDb` превращается в
 * `describe.skip`.
 */
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import {
  loginAs,
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';

describeWithDb('integration — read-only stock API', () => {
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
      manager: loginAs(t, seed.employees['shop-chief']!),
      seamstress: loginAs(t, seed.employees['seamstress']!),
    };
  });

  // ---------------------------------------------------------------------------
  // helpers — поднимаем заказ, приёмку и (опционально) расход через
  // существующие публичные эндпоинты (PurchaseReceipt → IN, MaterialIssue
  // POSTED → OUT). Это даёт нам реальные `StockBalance` и `StockMovement`.
  // ---------------------------------------------------------------------------

  async function prepareConfirmedPo(opts?: { qtyPlan?: number }): Promise<{
    orderId: string;
    workshopNeedId: string;
    purchaseOrderId: string;
    purchaseOrderLineId: string;
  }> {
    const qtyPlan = opts?.qtyPlan ?? 10;
    const supplier = await request(t.app.getHttpServer())
      .post('/api/suppliers')
      .set('Cookie', cookies.manager)
      .send({ name: `Supplier-${Date.now()}-${Math.random()}` })
      .expect(201);

    const catalog = await request(t.app.getHttpServer())
      .post(`/api/suppliers/${supplier.body.id}/catalog`)
      .set('Cookie', cookies.manager)
      .send({
        name: 'Кулирка 180 г/м² чёрная',
        unit: 'м',
        lastPrice: '500.00',
        currency: 'RUB',
      })
      .expect(201);

    const spec = await createSpecPattern(t, cookies.manager, {
      materialLines: [
        {
          name: 'Кулирка',
          unit: 'м',
          qtyPerUnit: '0.5',
          materialRole: 'MAIN_FABRIC',
          colorRule: 'ORDER_COLOR',
        },
      ],
    });

    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan }],
        patternItemId: spec.id,
      })
      .expect(201);
    const orderId = order.body.id as string;

    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const workshopNeedId = calc.body.needs[0].id as string;

    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${workshopNeedId}`)
      .set('Cookie', cookies.manager)
      .send({
        selectedSupplierId: supplier.body.id,
        selectedSupplierCatalogItemId: catalog.body.id,
        purchaseQty: String(qtyPlan * 2),
        quotedPrice: '500.00',
        quotedCurrency: 'RUB',
      })
      .expect(200);

    const po = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [workshopNeedId] })
      .expect(201);
    const purchaseOrderId = po.body.id as string;
    const purchaseOrderLineId = po.body.lines[0].id as string;

    await request(t.app.getHttpServer())
      .post(`/api/purchase-orders/${purchaseOrderId}/send`)
      .set('Cookie', cookies.manager)
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/purchase-orders/${purchaseOrderId}/confirm`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    return { orderId, workshopNeedId, purchaseOrderId, purchaseOrderLineId };
  }

  async function createPostedReceipt(opts: {
    purchaseOrderId: string;
    purchaseOrderLineId: string;
    receivedQty: string;
    cellId?: string;
  }): Promise<string> {
    const r = await request(t.app.getHttpServer())
      .post('/api/purchase-receipts/from-purchase-order')
      .set('Cookie', cookies.manager)
      .send({
        purchaseOrderId: opts.purchaseOrderId,
        lines: [
          {
            purchaseOrderLineId: opts.purchaseOrderLineId,
            receivedQty: opts.receivedQty,
            ...(opts.cellId ? { cellId: opts.cellId } : {}),
          },
        ],
      })
      .expect(201);
    return r.body.id as string;
  }

  async function postIssue(fx: {
    orderId: string;
    workshopNeedId: string;
    cellId?: string | null;
    issuedQty: string;
  }): Promise<string> {
    const created = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId: fx.orderId,
        lines: [
          {
            workshopNeedId: fx.workshopNeedId,
            issuedQty: fx.issuedQty,
            unitCost: '0',
            ...(fx.cellId ? { cellId: fx.cellId } : {}),
          },
        ],
      })
      .expect(201);
    const issueId = created.body.id as string;
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);
    return issueId;
  }

  // ===========================================================================
  // 1. balances возвращает массив остатков.
  // ===========================================================================

  test('GET /api/stock/balances возвращает items + total + limit + offset', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '5',
      cellId: seed.cells.A1.id,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/stock/balances')
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);

    const item = res.body.items.find(
      (i: { workshopNeedId: string }) => i.workshopNeedId === fx.workshopNeedId,
    );
    expect(item).toBeDefined();
    expect(item.orderId).toBe(fx.orderId);
    expect(typeof item.orderNumber).toBe('string');
    expect(item.cellCode).toBe(seed.cells.A1.code);
    expect(item.qty).toBe('5');
    // Decimal сериализуется строкой.
    expect(typeof item.unitCost).toBe('string');
    expect(typeof item.totalCost).toBe('string');
  });

  // ===========================================================================
  // 2. balances фильтрует по orderId (через relation).
  // ===========================================================================

  test('GET /api/stock/balances?orderId=... фильтрует через relation workshopNeed.orderId', async () => {
    const fxA = await prepareConfirmedPo();
    const fxB = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fxA.purchaseOrderId,
      purchaseOrderLineId: fxA.purchaseOrderLineId,
      receivedQty: '3',
      cellId: seed.cells.A1.id,
    });
    await createPostedReceipt({
      purchaseOrderId: fxB.purchaseOrderId,
      purchaseOrderLineId: fxB.purchaseOrderLineId,
      receivedQty: '7',
      cellId: seed.cells.A2.id,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/stock/balances')
      .query({ orderId: fxA.orderId })
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    for (const item of res.body.items) {
      expect(item.orderId).toBe(fxA.orderId);
    }
    const ids = res.body.items.map((i: { workshopNeedId: string }) => i.workshopNeedId);
    expect(ids).toContain(fxA.workshopNeedId);
    expect(ids).not.toContain(fxB.workshopNeedId);
  });

  // ===========================================================================
  // 3. balances positiveOnly=true.
  // ===========================================================================

  test('GET /api/stock/balances?positiveOnly=true возвращает только qty > 0', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '4',
      cellId: seed.cells.A1.id,
    });
    // Создаём баланс с qty < 0 на другой ячейке, чтобы фильтр имел смысл.
    await postIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '6',
      cellId: seed.cells.A2.id, // нет приёмки в A2 → баланс уйдёт в минус.
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/stock/balances')
      .query({ positiveOnly: 'true' })
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect(new Prisma.Decimal(item.qty).gt(0)).toBe(true);
    }
  });

  // ===========================================================================
  // 4. balances negativeOnly=true.
  // ===========================================================================

  test('GET /api/stock/balances?negativeOnly=true возвращает только qty < 0', async () => {
    const fx = await prepareConfirmedPo();
    // Без приёмки → списание уведёт балланс в минус (no-location или
    // explicit cell).
    await postIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '3',
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/stock/balances')
      .query({ negativeOnly: 'true' })
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect(new Prisma.Decimal(item.qty).lt(0)).toBe(true);
    }
  });

  // ===========================================================================
  // 5. balances positiveOnly + negativeOnly → 400 VALIDATION_ERROR.
  // ===========================================================================

  test('GET /api/stock/balances?positiveOnly=true&negativeOnly=true → 400 VALIDATION_ERROR', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/stock/balances')
      .query({ positiveOnly: 'true', negativeOnly: 'true' })
      .set('Cookie', cookies.manager)
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/взаимоисключающ/i);
  });

  // ===========================================================================
  // 6. movements возвращает массив движений.
  // ===========================================================================

  test('GET /api/stock/movements возвращает items + total + limit + offset', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '5',
      cellId: seed.cells.A1.id,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/stock/movements')
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);

    const movement = res.body.items.find(
      (i: { workshopNeedId: string }) => i.workshopNeedId === fx.workshopNeedId,
    );
    expect(movement).toBeDefined();
    expect(movement.direction).toBe('IN');
    expect(movement.type).toBe('PURCHASE_RECEIPT');
    expect(movement.qty).toBe('5');
    expect(movement.orderId).toBe(fx.orderId);
    expect(typeof movement.orderNumber).toBe('string');
    expect(movement.cellCode).toBe(seed.cells.A1.code);
  });

  // ===========================================================================
  // 7. movements filter by orderId.
  // ===========================================================================

  test('GET /api/stock/movements?orderId=... фильтрует через relation workshopNeed.orderId', async () => {
    const fxA = await prepareConfirmedPo();
    const fxB = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fxA.purchaseOrderId,
      purchaseOrderLineId: fxA.purchaseOrderLineId,
      receivedQty: '2',
      cellId: seed.cells.A1.id,
    });
    await createPostedReceipt({
      purchaseOrderId: fxB.purchaseOrderId,
      purchaseOrderLineId: fxB.purchaseOrderLineId,
      receivedQty: '8',
      cellId: seed.cells.A2.id,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/stock/movements')
      .query({ orderId: fxA.orderId })
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    for (const m of res.body.items) {
      expect(m.orderId).toBe(fxA.orderId);
    }
  });

  // ===========================================================================
  // 8. movements filter by type.
  // ===========================================================================

  test('GET /api/stock/movements?type=MATERIAL_ISSUE возвращает только OUT-движения по расходу', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '5',
      cellId: seed.cells.A1.id,
    });
    await postIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '2',
      cellId: seed.cells.A1.id,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/stock/movements')
      .query({ type: 'MATERIAL_ISSUE' })
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(res.body.items.length).toBeGreaterThan(0);
    for (const m of res.body.items) {
      expect(m.type).toBe('MATERIAL_ISSUE');
      expect(m.direction).toBe('OUT');
    }
  });

  // ===========================================================================
  // 9. movements filter by direction.
  // ===========================================================================

  test('GET /api/stock/movements?direction=IN возвращает только входящие', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '5',
      cellId: seed.cells.A1.id,
    });
    await postIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '2',
      cellId: seed.cells.A1.id,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/stock/movements')
      .query({ direction: 'IN' })
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(res.body.items.length).toBeGreaterThan(0);
    for (const m of res.body.items) {
      expect(m.direction).toBe('IN');
    }
  });

  // ===========================================================================
  // 10. movements filter by date range (from / to).
  // ===========================================================================

  test('GET /api/stock/movements?from=...&to=... ограничивает createdAt', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '3',
      cellId: seed.cells.A1.id,
    });

    // Окно «всё ещё впереди» — пустой ответ.
    const future = await request(t.app.getHttpServer())
      .get('/api/stock/movements')
      .query({
        from: '2099-01-01T00:00:00.000Z',
        to: '2099-12-31T00:00:00.000Z',
      })
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(future.body.items).toHaveLength(0);
    expect(future.body.total).toBe(0);

    // Окно «вокруг сейчас» — наше движение должно быть здесь.
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fut = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const now = await request(t.app.getHttpServer())
      .get('/api/stock/movements')
      .query({ from: past, to: fut })
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(now.body.items.length).toBeGreaterThanOrEqual(1);
  });

  // ===========================================================================
  // 11, 12. RBAC: SEAMSTRESS получает 403, ADMIN и SHOP_MANAGER — 200.
  // ===========================================================================

  test('SEAMSTRESS не имеет доступа к /api/stock/* (403 FORBIDDEN_ROLE)', async () => {
    const balances = await request(t.app.getHttpServer())
      .get('/api/stock/balances')
      .set('Cookie', cookies.seamstress)
      .expect(403);
    expect(balances.body.code).toBe('FORBIDDEN_ROLE');

    const movements = await request(t.app.getHttpServer())
      .get('/api/stock/movements')
      .set('Cookie', cookies.seamstress)
      .expect(403);
    expect(movements.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('Без авторизации /api/stock/* отдаёт 401 UNAUTHENTICATED', async () => {
    const balances = await request(t.app.getHttpServer())
      .get('/api/stock/balances')
      .expect(401);
    expect(balances.body.code).toBe('UNAUTHENTICATED');

    const movements = await request(t.app.getHttpServer())
      .get('/api/stock/movements')
      .expect(401);
    expect(movements.body.code).toBe('UNAUTHENTICATED');
  });

  test('ADMIN и SHOP_MANAGER оба могут читать balances/movements', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '1',
      cellId: seed.cells.A1.id,
    });

    await request(t.app.getHttpServer())
      .get('/api/stock/balances')
      .set('Cookie', t.adminCookie)
      .expect(200);
    await request(t.app.getHttpServer())
      .get('/api/stock/movements')
      .set('Cookie', t.adminCookie)
      .expect(200);
    await request(t.app.getHttpServer())
      .get('/api/stock/balances')
      .set('Cookie', cookies.manager)
      .expect(200);
    await request(t.app.getHttpServer())
      .get('/api/stock/movements')
      .set('Cookie', cookies.manager)
      .expect(200);
  });

  // ===========================================================================
  // 13. sourceKey не отдаётся в response.
  // ===========================================================================

  test('GET /api/stock/movements не возвращает sourceKey в response', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '4',
      cellId: seed.cells.A1.id,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/stock/movements')
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(res.body.items.length).toBeGreaterThan(0);
    for (const m of res.body.items) {
      expect(m).not.toHaveProperty('sourceKey');
    }

    // Дополнительно проверим, что в БД sourceKey есть (foundation
    // его пишет), но в API он скрыт.
    const dbMovement = await t.prisma.stockMovement.findFirst({
      where: { workshopNeedId: fx.workshopNeedId, type: 'PURCHASE_RECEIPT' },
    });
    expect(dbMovement?.sourceKey).toBeTruthy();
  });
});
