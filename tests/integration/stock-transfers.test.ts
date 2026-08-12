/**
 * Integration-тесты перемещения остатка между складами / ячейками
 * (`POST /api/stock/transfers`, см.
 *  `apps/api/src/modules/stock/stock.controller.ts`,
 *  `apps/api/src/modules/stock/stock.service.ts::createTransfer`,
 *  `apps/api/src/modules/stock/dto/create-stock-transfer.dto.ts`,
 *  `docs/api.md §«26a.4 POST /api/stock/transfers»`,
 *  `docs/current-state.md §«Перемещение остатка между складами»`).
 *
 * Покрытие (порядок совпадает с ТЗ §15 «Tests»):
 *
 *   1. POST /api/stock/transfers создаёт TRANSFER OUT и TRANSFER IN.
 *   2. Transfer уменьшает source StockBalance.qty.
 *   3. Transfer создаёт/увеличивает destination StockBalance.qty.
 *   4. Transfer использует source.unitCost для IN.
 *   5. Transfer rejects qty > source.qty (409 MATERIAL_STOCK_INSUFFICIENT).
 *   6. Transfer rejects same warehouse/cell (409 STOCK_TRANSFER_SAME_LOCATION).
 *   7. Transfer с тем же clientRequestId идемпотентен.
 *   8. Transfer response не возвращает sourceKey.
 *   9. Transfer to cell использует Cell.warehouseId.
 *  10. Transfer to warehouse без cell создаёт destination с cellId=null.
 *  11. SEAMSTRESS не имеет доступа (403 FORBIDDEN_ROLE).
 *  12. Transfer не влияет на MaterialIssue.totalCost.
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

describeWithDb('integration — stock transfers', () => {
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
  // helpers — поднимем приёмку через публичные эндпоинты, чтобы
  // получить реальный `StockBalance` с положительным qty и средней
  // ценой, и сразу прицепим ячейку A1 к источнику.
  // ---------------------------------------------------------------------------

  async function preparedBalance(
    receivedQty = '10',
    price = '500.00',
  ): Promise<{
    orderId: string;
    workshopNeedId: string;
    stockBalanceId: string;
    sourceWarehouseId: string;
    sourceCellId: string;
    destWarehouseId: string;
    destCellId: string;
  }> {
    // Заведём два склада: source и destination.
    const sourceWh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: `Источник-${Date.now()}-${Math.random()}` })
      .expect(201);
    const destWh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: `Назначение-${Date.now()}-${Math.random()}` })
      .expect(201);

    // Привязываем seed-ячейки к этим складам: A1 → source, A2 → dest.
    await t.prisma.cell.update({
      where: { id: seed.cells.A1!.id },
      data: { warehouseId: sourceWh.body.id },
    });
    await t.prisma.cell.update({
      where: { id: seed.cells.A2!.id },
      data: { warehouseId: destWh.body.id },
    });

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
        lastPrice: price,
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
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
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
        purchaseQty: '20',
        quotedPrice: price,
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

    await request(t.app.getHttpServer())
      .post('/api/purchase-receipts/from-purchase-order')
      .set('Cookie', cookies.manager)
      .send({
        purchaseOrderId,
        lines: [
          {
            purchaseOrderLineId,
            receivedQty,
            cellId: seed.cells.A1!.id,
          },
        ],
      })
      .expect(201);

    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId },
    });
    return {
      orderId,
      workshopNeedId,
      stockBalanceId: balance.id,
      sourceWarehouseId: sourceWh.body.id,
      sourceCellId: seed.cells.A1!.id,
      destWarehouseId: destWh.body.id,
      destCellId: seed.cells.A2!.id,
    };
  }

  // ===========================================================================
  // 1. POST /api/stock/transfers создаёт TRANSFER OUT и TRANSFER IN.
  // ===========================================================================

  test('POST /api/stock/transfers создаёт пару StockMovement TRANSFER OUT/IN', async () => {
    const fx = await preparedBalance('10');

    const res = await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toWarehouseId: fx.destWarehouseId,
        qty: '3',
        comment: 'Тестовое перемещение на склад кроя',
        clientRequestId: `tr1-${Date.now()}`,
      })
      .expect(201);

    expect(res.body.transferId).toBeTruthy();
    expect(res.body.outMovement.type).toBe('TRANSFER');
    expect(res.body.outMovement.direction).toBe('OUT');
    expect(res.body.inMovement.type).toBe('TRANSFER');
    expect(res.body.inMovement.direction).toBe('IN');
    expect(res.body.outMovement.qty).toBe('3');
    expect(res.body.inMovement.qty).toBe('3');
  });

  // ===========================================================================
  // 2. Transfer уменьшает source StockBalance.qty.
  // ===========================================================================

  test('Transfer уменьшает source StockBalance.qty', async () => {
    const fx = await preparedBalance('10');

    await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toWarehouseId: fx.destWarehouseId,
        qty: '4',
        comment: 'Перемещение',
        clientRequestId: `tr2-${Date.now()}`,
      })
      .expect(201);

    const source = await t.prisma.stockBalance.findUniqueOrThrow({
      where: { id: fx.stockBalanceId },
    });
    expect(source.qty.toString()).toBe('6');
  });

  // ===========================================================================
  // 3. Transfer создаёт/увеличивает destination StockBalance.qty.
  // ===========================================================================

  test('Transfer создаёт destination StockBalance с тем же workshopNeedId', async () => {
    const fx = await preparedBalance('10');

    await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toWarehouseId: fx.destWarehouseId,
        qty: '3',
        comment: 'Перемещение',
        clientRequestId: `tr3-${Date.now()}`,
      })
      .expect(201);

    const dest = await t.prisma.stockBalance.findFirstOrThrow({
      where: {
        workshopNeedId: fx.workshopNeedId,
        warehouseId: fx.destWarehouseId,
        cellId: null,
      },
    });
    expect(dest.qty.toString()).toBe('3');
  });

  // ===========================================================================
  // 4. Transfer использует source.unitCost для IN.
  // ===========================================================================

  test('Transfer использует source.unitCost для IN-движения', async () => {
    const fx = await preparedBalance('10', '500.00');

    const res = await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toWarehouseId: fx.destWarehouseId,
        qty: '4',
        comment: 'Перемещение',
        clientRequestId: `tr4-${Date.now()}`,
      })
      .expect(201);

    expect(res.body.inMovement.unitCost).toBe('500');
    expect(res.body.outMovement.unitCost).toBe('500');

    const dest = await t.prisma.stockBalance.findFirstOrThrow({
      where: {
        workshopNeedId: fx.workshopNeedId,
        warehouseId: fx.destWarehouseId,
        cellId: null,
      },
    });
    expect(new Prisma.Decimal(dest.unitCost).eq(new Prisma.Decimal('500'))).toBe(
      true,
    );
  });

  // ===========================================================================
  // 5. Transfer rejects qty > source.qty (409 MATERIAL_STOCK_INSUFFICIENT).
  // ===========================================================================

  test('qty > source.qty → 409 MATERIAL_STOCK_INSUFFICIENT, баланс не меняется', async () => {
    const fx = await preparedBalance('5');

    const before = await t.prisma.stockBalance.findUniqueOrThrow({
      where: { id: fx.stockBalanceId },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toWarehouseId: fx.destWarehouseId,
        qty: '10',
        comment: 'Перемещение сверх остатка',
        clientRequestId: `tr5-${Date.now()}`,
      })
      .expect(409);
    expect(res.body.code).toBe('MATERIAL_STOCK_INSUFFICIENT');

    const after = await t.prisma.stockBalance.findUniqueOrThrow({
      where: { id: fx.stockBalanceId },
    });
    expect(after.qty.toString()).toBe(before.qty.toString());

    const movements = await t.prisma.stockMovement.findMany({
      where: { type: 'TRANSFER' },
    });
    expect(movements).toHaveLength(0);
  });

  // ===========================================================================
  // 6. Transfer rejects same warehouse/cell (409 STOCK_TRANSFER_SAME_LOCATION).
  // ===========================================================================

  test('source и destination совпадают → 409 STOCK_TRANSFER_SAME_LOCATION', async () => {
    const fx = await preparedBalance('10');

    // Назначение — та же ячейка A1.
    const res = await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toCellId: fx.sourceCellId,
        qty: '2',
        comment: 'Перемещение в ту же ячейку',
        clientRequestId: `tr6-${Date.now()}`,
      })
      .expect(409);
    expect(res.body.code).toBe('STOCK_TRANSFER_SAME_LOCATION');
  });

  // ===========================================================================
  // 7. Идемпотентность по clientRequestId.
  // ===========================================================================

  test('повторный submit с тем же clientRequestId возвращает существующую пару', async () => {
    const fx = await preparedBalance('10');
    const clientRequestId = `idem-${Date.now()}`;

    const first = await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toWarehouseId: fx.destWarehouseId,
        qty: '2',
        comment: 'Идемпотентное перемещение',
        clientRequestId,
      })
      .expect(201);

    const second = await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toWarehouseId: fx.destWarehouseId,
        qty: '2',
        comment: 'Идемпотентное перемещение',
        clientRequestId,
      })
      .expect(201);

    expect(second.body.outMovement.id).toBe(first.body.outMovement.id);
    expect(second.body.inMovement.id).toBe(first.body.inMovement.id);

    const source = await t.prisma.stockBalance.findUniqueOrThrow({
      where: { id: fx.stockBalanceId },
    });
    // qty уменьшен ровно один раз (10 - 2 = 8), а не дважды.
    expect(source.qty.toString()).toBe('8');

    const movements = await t.prisma.stockMovement.findMany({
      where: { type: 'TRANSFER' },
    });
    expect(movements).toHaveLength(2);
  });

  // ===========================================================================
  // 8. sourceKey не возвращается в response.
  // ===========================================================================

  test('sourceKey не отдаётся в response', async () => {
    const fx = await preparedBalance('10');
    const res = await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toWarehouseId: fx.destWarehouseId,
        qty: '1',
        comment: 'Без sourceKey',
        clientRequestId: `tr8-${Date.now()}`,
      })
      .expect(201);
    expect(res.body.outMovement).not.toHaveProperty('sourceKey');
    expect(res.body.inMovement).not.toHaveProperty('sourceKey');

    // Но в БД sourceKey есть с префиксом STOCK_TRANSFER:
    const out = await t.prisma.stockMovement.findUniqueOrThrow({
      where: { id: res.body.outMovement.id },
    });
    const inMov = await t.prisma.stockMovement.findUniqueOrThrow({
      where: { id: res.body.inMovement.id },
    });
    expect(out.sourceKey?.startsWith('STOCK_TRANSFER:')).toBe(true);
    expect(out.sourceKey?.endsWith(':OUT')).toBe(true);
    expect(inMov.sourceKey?.startsWith('STOCK_TRANSFER:')).toBe(true);
    expect(inMov.sourceKey?.endsWith(':IN')).toBe(true);
  });

  // ===========================================================================
  // 9. Transfer to cell использует Cell.warehouseId.
  // ===========================================================================

  test('Transfer to cell использует Cell.warehouseId для destination', async () => {
    const fx = await preparedBalance('10');

    const res = await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toCellId: fx.destCellId,
        qty: '3',
        comment: 'Перемещение в конкретную ячейку',
        clientRequestId: `tr9-${Date.now()}`,
      })
      .expect(201);

    expect(res.body.inMovement.cellId).toBe(fx.destCellId);
    expect(res.body.inMovement.warehouseId).toBe(fx.destWarehouseId);
  });

  // ===========================================================================
  // 10. Transfer to warehouse без cell создаёт destination с cellId=null.
  // ===========================================================================

  test('Transfer to warehouse без cell создаёт destination balance с cellId=null', async () => {
    const fx = await preparedBalance('10');

    const res = await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toWarehouseId: fx.destWarehouseId,
        qty: '3',
        comment: 'Перемещение на склад без ячейки',
        clientRequestId: `tr10-${Date.now()}`,
      })
      .expect(201);

    expect(res.body.inMovement.cellId).toBeNull();
    expect(res.body.inMovement.warehouseId).toBe(fx.destWarehouseId);
  });

  // ===========================================================================
  // 11. SEAMSTRESS — 403.
  // ===========================================================================

  test('SEAMSTRESS не имеет доступа к POST /api/stock/transfers (403)', async () => {
    const fx = await preparedBalance('10');
    const res = await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.seamstress)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toWarehouseId: fx.destWarehouseId,
        qty: '1',
        comment: 'попытка швеи',
        clientRequestId: `tr11-${Date.now()}`,
      })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  // ===========================================================================
  // 12. Transfer не влияет на MaterialIssue.totalCost.
  // ===========================================================================

  test('Transfer не влияет на MaterialIssue / order summary', async () => {
    const fx = await preparedBalance('10', '500.00');

    // До transfer-а — `MaterialIssue` по этому заказу нет.
    const issuesBefore = await t.prisma.materialIssue.count({
      where: { orderId: fx.orderId },
    });
    expect(issuesBefore).toBe(0);

    await request(t.app.getHttpServer())
      .post('/api/stock/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromStockBalanceId: fx.stockBalanceId,
        toWarehouseId: fx.destWarehouseId,
        qty: '4',
        comment: 'Перемещение не создаёт MaterialIssue',
        clientRequestId: `tr12-${Date.now()}`,
      })
      .expect(201);

    // После transfer-а — `MaterialIssue` всё равно нет.
    const issuesAfter = await t.prisma.materialIssue.count({
      where: { orderId: fx.orderId },
    });
    expect(issuesAfter).toBe(0);
  });
});
