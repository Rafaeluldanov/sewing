/**
 * Integration-тесты подключения приёмки к складскому foundation
 * (см. ТЗ «PurchaseReceipt → StockMovement IN»,
 * `apps/api/src/modules/stock/stock.service.ts`,
 * `apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts`).
 *
 * Покрытие:
 *
 *   1. Создание POSTED PurchaseReceipt создаёт StockMovement IN.
 *   2. Создание POSTED PurchaseReceipt увеличивает StockBalance.qty.
 *   3. StockBalance создаётся с balanceKey по
 *      workshopNeedId / warehouseId / cellId.
 *   4. priceSnapshot RUB используется как unitCost.
 *   5. priceSnapshot USD даёт unitCost = 0.
 *   6. priceSnapshot null даёт unitCost = 0.
 *   7. PurchaseReceiptLine без workshopNeedId не создаёт StockMovement
 *      и не ломает receipt.
 *   8. PurchaseReceiptLine с receivedQty <= 0 не создаёт StockMovement
 *      (бизнес-flow `from-purchase-order` сам валидирует qty > 0,
 *      поэтому проверяем soft-skip напрямую через `recordPurchaseReceiptInTx`).
 *   9. Повторная обработка той же PurchaseReceiptLine не создаёт дубль
 *      IN movement.
 *  10. Cancel PurchaseReceipt создаёт REVERSAL OUT, если исходный IN
 *      существует.
 *  11. Cancel PurchaseReceipt уменьшает StockBalance.qty.
 *  12. Повторный cancel / retry не создаёт дубль REVERSAL.
 *  13. Cancel старой PurchaseReceipt без исходного IN не создаёт
 *      reversal и не падает.
 *  14. MaterialIssuesService.post подключён к StockService и
 *      уменьшает StockBalance.qty на issuedQty (проверка симметрии
 *      IN/OUT — прямые сценарии расхода покрываются
 *      `tests/integration/material-issues-stock.test.ts`).
 *  15. AUTO_CUT_ISSUE подключён к StockService (симметрия IN/OUT).
 *
 * Тесты используют `TEST_DATABASE_URL` — без неё `describeWithDb`
 * превращается в `describe.skip`.
 */
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import {
  StockService,
  buildPurchaseReceiptLineCancelStockSourceKey,
  buildPurchaseReceiptLineStockSourceKey,
  buildStockBalanceKey,
} from '@sewing/api/modules/stock/stock.service';

import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — purchase receipt → stock movements', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let stock: StockService;

  beforeAll(async () => {
    t = await startTestApp();
    stock = t.app.get(StockService);
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
    };
  });

  // ===========================================================================
  // helpers
  // ===========================================================================

  /**
   * Готовит цепочку Supplier → CatalogItem → TechCard → Order →
   * WorkshopNeed → PurchaseOrder (CONFIRMED) и возвращает id-шники
   * для дальнейшего create-PR. По умолчанию — RUB-цена 500/м,
   * можно перекрыть через opts.
   */
  async function prepareConfirmedPo(opts?: {
    currency?: string;
    price?: string | null;
  }): Promise<{
    orderId: string;
    workshopNeedId: string;
    purchaseOrderId: string;
    purchaseOrderLineId: string;
  }> {
    const currency = opts?.currency ?? 'RUB';
    const price = opts?.price === undefined ? '500.00' : opts.price;

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
        ...(price === null
          ? {}
          : { lastPrice: price, currency }),
      })
      .expect(201);

    const tcCode = `TC-PR-STK-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const tc = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: tcCode,
        name: tcCode,
        materialLines: [
          {
            name: 'Кулирка',
            unit: 'м',
            qtyPerUnit: '0.5',
            materialRole: 'MAIN_FABRIC',
          },
        ],
      })
      .expect(201);

    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 50 }],
        techCardId: tc.body.id,
      })
      .expect(201);
    const orderId = order.body.id as string;

    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const workshopNeedId = calc.body.needs[0].id as string;

    const patchBody: Record<string, string> = {
      selectedSupplierId: supplier.body.id,
      selectedSupplierCatalogItemId: catalog.body.id,
      purchaseQty: '25',
    };
    if (price !== null) {
      patchBody.quotedPrice = price;
      patchBody.quotedCurrency = currency;
    }
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${workshopNeedId}`)
      .set('Cookie', cookies.manager)
      .send(patchBody)
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

  async function createWarehouseAndCell(): Promise<{
    warehouseId: string;
    cellId: string;
  }> {
    const wh = await request(t.app.getHttpServer())
      .post('/api/warehouses')
      .set('Cookie', cookies.manager)
      .send({ name: `WH-${Math.random().toString(36).slice(2, 7)}` })
      .expect(201);
    const cellId = seed.cells['A1'].id;
    await request(t.app.getHttpServer())
      .patch(`/api/cells/${cellId}`)
      .set('Cookie', cookies.manager)
      .send({ warehouseId: wh.body.id })
      .expect(200);
    return { warehouseId: wh.body.id as string, cellId };
  }

  async function createPostedReceipt(opts: {
    purchaseOrderId: string;
    purchaseOrderLineId: string;
    receivedQty: string;
    cellId?: string | null;
  }): Promise<{ receiptId: string; receiptLineId: string }> {
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
    return {
      receiptId: r.body.id as string,
      receiptLineId: r.body.lines[0].id as string,
    };
  }

  // ===========================================================================
  // 1, 2, 3, 4. Happy path: POSTED PR → IN, qty/balance, balanceKey, RUB price.
  // ===========================================================================

  test('POSTED PurchaseReceipt создаёт StockMovement IN, увеличивает StockBalance.qty, balanceKey строится по WN/WH/Cell, RUB priceSnapshot → unitCost', async () => {
    const fx = await prepareConfirmedPo({ currency: 'RUB', price: '500.00' });
    const { warehouseId, cellId } = await createWarehouseAndCell();

    const { receiptId, receiptLineId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '20',
      cellId,
    });

    // Movement создан ровно один, с правильными полями.
    const movements = await t.prisma.stockMovement.findMany({
      where: { purchaseReceiptId: receiptId },
    });
    expect(movements).toHaveLength(1);
    const m = movements[0]!;
    expect(m.direction).toBe('IN');
    expect(m.type).toBe('PURCHASE_RECEIPT');
    expect(m.purchaseReceiptId).toBe(receiptId);
    expect(m.purchaseReceiptLineId).toBe(receiptLineId);
    expect(m.workshopNeedId).toBe(fx.workshopNeedId);
    expect(m.warehouseId).toBe(warehouseId);
    expect(m.cellId).toBe(cellId);
    expect(m.unit).toBe('м');
    expect(new Prisma.Decimal(m.qty).toString()).toBe('20');
    expect(new Prisma.Decimal(m.unitCost).toString()).toBe('500');
    expect(new Prisma.Decimal(m.totalCost).toString()).toBe('10000');
    expect(m.sourceType).toBe('PURCHASE_RECEIPT_LINE');
    expect(m.sourceId).toBe(receiptLineId);
    expect(m.sourceKey).toBe(
      buildPurchaseReceiptLineStockSourceKey(receiptLineId),
    );

    // Balance создан, qty увеличился, balanceKey по WN/WH/Cell.
    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    expect(balance.balanceKey).toBe(
      buildStockBalanceKey(fx.workshopNeedId, warehouseId, cellId),
    );
    expect(balance.warehouseId).toBe(warehouseId);
    expect(balance.cellId).toBe(cellId);
    expect(balance.unit).toBe('м');
    expect(new Prisma.Decimal(balance.qty).toString()).toBe('20');
    expect(new Prisma.Decimal(balance.unitCost).toString()).toBe('500');
    expect(new Prisma.Decimal(balance.totalCost).toString()).toBe('10000');
  });

  // ===========================================================================
  // 5. priceSnapshot USD → unitCost = 0
  // ===========================================================================

  test('priceSnapshot USD → unitCost = 0 (конвертацию валют не делаем)', async () => {
    const fx = await prepareConfirmedPo({ currency: 'USD', price: '5.00' });
    const { receiptId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
    });
    const m = await t.prisma.stockMovement.findFirstOrThrow({
      where: { purchaseReceiptId: receiptId },
    });
    expect(new Prisma.Decimal(m.unitCost).toString()).toBe('0');
    expect(new Prisma.Decimal(m.totalCost).toString()).toBe('0');
  });

  // ===========================================================================
  // 6. priceSnapshot null → unitCost = 0
  // ===========================================================================

  test('priceSnapshot null → unitCost = 0', async () => {
    const fx = await prepareConfirmedPo({ price: null });
    const { receiptId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
    });
    const m = await t.prisma.stockMovement.findFirstOrThrow({
      where: { purchaseReceiptId: receiptId },
    });
    expect(new Prisma.Decimal(m.unitCost).toString()).toBe('0');
  });

  // ===========================================================================
  // 7. PurchaseReceiptLine без workshopNeedId — soft-skip, receipt OK.
  //    Бизнес-flow `from-purchase-order` всегда тянет workshopNeedId из
  //    строки PO, поэтому подменяем уже после создания и вызываем
  //    `recordPurchaseReceiptInTx` напрямую.
  // ===========================================================================

  test('строка без workshopNeedId не создаёт StockMovement и не падает', async () => {
    const fx = await prepareConfirmedPo();
    const { receiptId, receiptLineId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
    });
    // Сбрасываем существующий movement и убираем workshopNeedId у
    // строки, чтобы проверить чистый soft-skip.
    await t.prisma.stockMovement.deleteMany({
      where: { purchaseReceiptLineId: receiptLineId },
    });
    await t.prisma.stockBalance.deleteMany({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    await t.prisma.purchaseReceiptLine.update({
      where: { id: receiptLineId },
      data: { workshopNeedId: null },
    });

    await t.prisma.$transaction(async (tx) => {
      const created = await stock.recordPurchaseReceiptInTx(
        tx,
        receiptId,
        null,
      );
      expect(created).toHaveLength(0);
    });

    expect(
      await t.prisma.stockMovement.count({
        where: { purchaseReceiptLineId: receiptLineId },
      }),
    ).toBe(0);
    expect(
      await t.prisma.stockBalance.count({
        where: { workshopNeedId: fx.workshopNeedId },
      }),
    ).toBe(0);
  });

  // ===========================================================================
  // 8. PurchaseReceiptLine с receivedQty <= 0 — soft-skip.
  //    `from-purchase-order` валидирует qty > 0 (422 PR_QTY_REQUIRED),
  //    поэтому подменяем receivedQty прямо в БД и вызываем
  //    `recordPurchaseReceiptInTx` повторно.
  // ===========================================================================

  test('строка с receivedQty <= 0 не создаёт StockMovement', async () => {
    const fx = await prepareConfirmedPo();
    const { receiptId, receiptLineId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
    });
    await t.prisma.stockMovement.deleteMany({
      where: { purchaseReceiptLineId: receiptLineId },
    });
    await t.prisma.stockBalance.deleteMany({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    await t.prisma.purchaseReceiptLine.update({
      where: { id: receiptLineId },
      data: { receivedQty: new Prisma.Decimal(0) },
    });

    await t.prisma.$transaction(async (tx) => {
      const created = await stock.recordPurchaseReceiptInTx(
        tx,
        receiptId,
        null,
      );
      expect(created).toHaveLength(0);
    });
    expect(
      await t.prisma.stockMovement.count({
        where: { purchaseReceiptLineId: receiptLineId },
      }),
    ).toBe(0);
  });

  // ===========================================================================
  // 9. Идемпотентность: повторная обработка той же приёмки не пишет
  //    дубль IN movement и не удваивает StockBalance.qty.
  // ===========================================================================

  test('повторная обработка PurchaseReceipt не создаёт дубль IN movement', async () => {
    const fx = await prepareConfirmedPo();
    const { receiptId, receiptLineId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '15',
    });
    // Первый вызов уже произошёл при создании. Пробуем повторить
    // вручную — должен быть no-op.
    await t.prisma.$transaction(async (tx) => {
      const second = await stock.recordPurchaseReceiptInTx(
        tx,
        receiptId,
        null,
      );
      expect(second).toHaveLength(1);
      expect(second[0]!.sourceKey).toBe(
        buildPurchaseReceiptLineStockSourceKey(receiptLineId),
      );
    });
    const movementCount = await t.prisma.stockMovement.count({
      where: { purchaseReceiptLineId: receiptLineId },
    });
    expect(movementCount).toBe(1);

    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    expect(new Prisma.Decimal(balance.qty).toString()).toBe('15');
  });

  // ===========================================================================
  // 10, 11. Cancel: REVERSAL OUT создаётся, StockBalance.qty уменьшается.
  // ===========================================================================

  test('cancel PurchaseReceipt создаёт REVERSAL OUT и уменьшает StockBalance.qty', async () => {
    const fx = await prepareConfirmedPo();
    const { receiptId, receiptLineId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '12',
    });
    const balanceBefore = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    expect(new Prisma.Decimal(balanceBefore.qty).toString()).toBe('12');

    await request(t.app.getHttpServer())
      .post(`/api/purchase-receipts/${receiptId}/cancel`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'тест' })
      .expect(201);

    const reversal = await t.prisma.stockMovement.findFirstOrThrow({
      where: {
        sourceKey: buildPurchaseReceiptLineCancelStockSourceKey(receiptLineId),
      },
    });
    expect(reversal.direction).toBe('OUT');
    expect(reversal.type).toBe('REVERSAL');
    expect(reversal.sourceType).toBe('PURCHASE_RECEIPT_LINE_CANCEL');
    expect(reversal.purchaseReceiptId).toBe(receiptId);
    expect(reversal.purchaseReceiptLineId).toBe(receiptLineId);
    expect(reversal.workshopNeedId).toBe(fx.workshopNeedId);
    expect(new Prisma.Decimal(reversal.qty).toString()).toBe('12');
    expect(reversal.comment).toBe('Отмена приёмки');

    const balanceAfter = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    expect(new Prisma.Decimal(balanceAfter.qty).toString()).toBe('0');
  });

  // ===========================================================================
  // 12. Идемпотентность cancel: повторный вызов не создаёт дубль REVERSAL.
  //     PurchaseReceiptsService.cancel сам идемпотентен по статусу, но
  //     дополнительно дёргаем `reversePurchaseReceiptInTx` напрямую,
  //     чтобы поймать именно UNIQUE на sourceKey.
  // ===========================================================================

  test('повторный cancel / retry не создаёт дубль REVERSAL', async () => {
    const fx = await prepareConfirmedPo();
    const { receiptId, receiptLineId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '8',
    });
    await request(t.app.getHttpServer())
      .post(`/api/purchase-receipts/${receiptId}/cancel`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    // Повторный cancel — идемпотентный (сервис сам ловит CANCELLED).
    await request(t.app.getHttpServer())
      .post(`/api/purchase-receipts/${receiptId}/cancel`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    // Прямой повторный вызов reversePurchaseReceiptInTx также no-op.
    await t.prisma.$transaction(async (tx) => {
      const second = await stock.reversePurchaseReceiptInTx(
        tx,
        receiptId,
        null,
      );
      expect(second).toHaveLength(1);
      expect(second[0]!.sourceKey).toBe(
        buildPurchaseReceiptLineCancelStockSourceKey(receiptLineId),
      );
    });
    const reversalCount = await t.prisma.stockMovement.count({
      where: {
        sourceKey: buildPurchaseReceiptLineCancelStockSourceKey(receiptLineId),
      },
    });
    expect(reversalCount).toBe(1);
  });

  // ===========================================================================
  // 13. Старая приёмка без исходного IN: cancel не пишет reversal и не
  //     падает. Эмулируем удалением исходного IN movement.
  // ===========================================================================

  test('cancel старой PurchaseReceipt без исходного IN не создаёт reversal и не падает', async () => {
    const fx = await prepareConfirmedPo();
    const { receiptId, receiptLineId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '7',
    });
    // Симулируем «старую» приёмку: сносим движение и баланс, как будто
    // их никогда не было (приёмка создавалась до подключения склада).
    await t.prisma.stockMovement.deleteMany({
      where: { purchaseReceiptId: receiptId },
    });
    await t.prisma.stockBalance.deleteMany({
      where: { workshopNeedId: fx.workshopNeedId },
    });

    await request(t.app.getHttpServer())
      .post(`/api/purchase-receipts/${receiptId}/cancel`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    expect(
      await t.prisma.stockMovement.count({
        where: {
          sourceKey:
            buildPurchaseReceiptLineCancelStockSourceKey(receiptLineId),
        },
      }),
    ).toBe(0);
  });

  // ===========================================================================
  // 14. MaterialIssuesService.post симметрично уменьшает StockBalance.qty
  //     (подключение MaterialIssue → StockMovement OUT). Полный набор
  //     сценариев расхода живёт в `material-issues-stock.test.ts`.
  // ===========================================================================

  test('MaterialIssue.post уменьшает StockBalance.qty на issuedQty (IN/OUT симметрия)', async () => {
    const fx = await prepareConfirmedPo();
    const { receiptId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
    });
    const balanceAfterReceipt = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    expect(new Prisma.Decimal(balanceAfterReceipt.qty).toString()).toBe('10');

    const created = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId: fx.orderId,
        lines: [
          {
            workshopNeedId: fx.workshopNeedId,
            issuedQty: '4',
            unitCost: '500',
          },
        ],
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${created.body.id}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const balanceAfterPost = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    expect(new Prisma.Decimal(balanceAfterPost.qty).toString()).toBe('6');
    const issueMovements = await t.prisma.stockMovement.count({
      where: {
        workshopNeedId: fx.workshopNeedId,
        type: 'MATERIAL_ISSUE',
        direction: 'OUT',
      },
    });
    expect(issueMovements).toBe(1);
    expect(receiptId.length).toBeGreaterThan(0);
  });

  // ===========================================================================
  // 15. AUTO_CUT_ISSUE симметрично уменьшает StockBalance.qty через
  //     MaterialIssuesService. Полный набор сценариев авто-списания
  //     живёт в `material-issues-stock.test.ts`.
  // ===========================================================================

  test('AUTO_CUT_ISSUE создаёт StockMovement OUT через MaterialIssuesService', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '25',
    });

    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        singleton: true,
        autoIssueMaterialsOnCutRelease: true,
      },
      update: { autoIssueMaterialsOnCutRelease: true },
    });

    const seamstressCookie = loginAs(t, seed.employees['seamstress']);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${fx.orderId}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId: fx.orderId,
        sizeId: seed.sizes.M,
        rollNumber: `R-AUTO-${Date.now()}`,
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 5,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passport.body.id}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', seamstressCookie)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passport.body.id}/issue`)
      .set('Cookie', seamstressCookie)
      .send({})
      .expect(201);

    const auto = await t.prisma.materialIssue.findFirstOrThrow({
      where: { passportId: passport.body.id, source: 'AUTO_CUT_ISSUE' },
      include: { lines: true },
    });
    expect(auto.status).toBe('POSTED');
    expect(auto.lines.length).toBeGreaterThan(0);
    const issuedTotal = auto.lines.reduce(
      (acc, l) => acc.add(new Prisma.Decimal(l.issuedQty)),
      new Prisma.Decimal(0),
    );

    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    expect(new Prisma.Decimal(balance.qty).toString()).toBe(
      new Prisma.Decimal(25).sub(issuedTotal).toString(),
    );
    const issueMovements = await t.prisma.stockMovement.findMany({
      where: { workshopNeedId: fx.workshopNeedId, type: 'MATERIAL_ISSUE' },
    });
    expect(issueMovements.length).toBe(auto.lines.length);
    for (const m of issueMovements) {
      expect(m.direction).toBe('OUT');
      expect(m.materialIssueId).toBe(auto.id);
      expect(m.comment).toBe('Автоматическое списание при выдаче кроя');
    }
  });
});
