/**
 * Integration-тесты подключения расхода материалов к складскому
 * foundation (см. ТЗ «MaterialIssue → StockMovement OUT»,
 * `apps/api/src/modules/stock/stock.service.ts`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts`).
 *
 * Покрытие (номера совпадают с ТЗ §13):
 *
 *   1. MaterialIssue.post создаёт StockMovement OUT.
 *   2. MaterialIssue.post уменьшает StockBalance.qty.
 *   3. MaterialIssue.create DRAFT не создаёт StockMovement.
 *   4. MaterialIssue.cancel DRAFT не создаёт StockMovement.
 *   5. POSTED MaterialIssue.cancel всё ещё запрещён.
 *   6. MaterialIssueLine без workshopNeedId не создаёт StockMovement
 *      и не ломает post.
 *   7. MaterialIssueLine с issuedQty <= 0 soft-skip (прямой вызов
 *      `recordMaterialIssueInTx`, т.к. POST-DTO отвергает такое qty).
 *   8. MaterialIssueLine с explicit cellId списывает из этой ячейки.
 *   9. MaterialIssueLine без cellId выбирает существующий
 *      положительный StockBalance с максимальным qty.
 *  10. Если положительного StockBalance нет, создаётся/используется
 *      no-location balance и qty уходит в минус.
 *  11. OUT movement sourceKey = MATERIAL_ISSUE_LINE:<lineId>.
 *  12. Повторная обработка той же MaterialIssueLine не создаёт дубль OUT.
 *  13. StockMovement OUT использует текущий balance.unitCost, а НЕ
 *      MaterialIssueLine.unitCost.
 *  14. MaterialIssue.totalCost не меняется после stock OUT.
 *  15. AUTO_CUT_ISSUE создаёт StockMovement OUT через MaterialIssuesService.
 *  16. AUTO_CUT_ISSUE не блокирует issueToEmployee при недостатке остатка.
 *
 * Тесты используют `TEST_DATABASE_URL` — без неё `describeWithDb`
 * превращается в `describe.skip`.
 */
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import {
  StockService,
  buildMaterialIssueLineStockSourceKey,
  buildPurchaseReceiptLineStockSourceKey,
} from '@sewing/api/modules/stock/stock.service';

import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — material issue → stock movements', () => {
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
      seamstress: loginAs(t, seed.employees['seamstress']),
    };
  });

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * Готовит заказ с одной `WorkshopNeed` (MAIN_FABRIC, unit `м`) и
   * CONFIRMED `PurchaseOrder`, возвращает id-шники. По умолчанию
   * RUB-цена 500/м, qtyPlan 10. Нужен для создания приёмки и
   * соответствующего `StockBalance`.
   */
  async function prepareConfirmedPo(opts?: {
    currency?: string;
    price?: string | null;
    qtyPlan?: number;
  }): Promise<{
    orderId: string;
    workshopNeedId: string;
    purchaseOrderId: string;
    purchaseOrderLineId: string;
  }> {
    const currency = opts?.currency ?? 'RUB';
    const price = opts?.price === undefined ? '500.00' : opts.price;
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
        ...(price === null ? {} : { lastPrice: price, currency }),
      })
      .expect(201);

    const tcCode = `TC-MI-STK-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
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
            colorRule: 'ORDER_COLOR',
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
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan }],
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
      purchaseQty: String(qtyPlan * 2),
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

  async function createDraftIssue(opts: {
    orderId: string;
    workshopNeedId: string;
    issuedQty: string;
    unitCost?: string;
    cellId?: string | null;
  }): Promise<{ issueId: string; lineId: string }> {
    const res = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId: opts.orderId,
        lines: [
          {
            workshopNeedId: opts.workshopNeedId,
            issuedQty: opts.issuedQty,
            unitCost: opts.unitCost ?? '0',
            ...(opts.cellId ? { cellId: opts.cellId } : {}),
          },
        ],
      })
      .expect(201);
    return {
      issueId: res.body.id as string,
      lineId: res.body.lines[0].id as string,
    };
  }

  // ===========================================================================
  // 1, 2, 11, 14. Happy path: post пишет OUT, balance уменьшается,
  //   sourceKey корректный, totalCost документа НЕ меняется.
  // ===========================================================================

  test('MaterialIssue.post создаёт StockMovement OUT, уменьшает StockBalance.qty, использует sourceKey MATERIAL_ISSUE_LINE:<lineId>, totalCost документа не меняется', async () => {
    const fx = await prepareConfirmedPo();
    const { receiptLineId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '20',
      cellId: seed.cells.A1.id,
    });
    expect(receiptLineId.length).toBeGreaterThan(0);

    const { issueId, lineId } = await createDraftIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '4',
      unitCost: '999',
      cellId: seed.cells.A1.id,
    });

    // До post движений MATERIAL_ISSUE нет.
    expect(
      await t.prisma.stockMovement.count({
        where: { materialIssueId: issueId },
      }),
    ).toBe(0);

    const posted = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const movement = await t.prisma.stockMovement.findFirstOrThrow({
      where: { materialIssueLineId: lineId },
    });
    expect(movement.direction).toBe('OUT');
    expect(movement.type).toBe('MATERIAL_ISSUE');
    expect(movement.materialIssueId).toBe(issueId);
    expect(movement.materialIssueLineId).toBe(lineId);
    expect(movement.workshopNeedId).toBe(fx.workshopNeedId);
    expect(movement.unit).toBe('м');
    expect(new Prisma.Decimal(movement.qty).toString()).toBe('4');
    expect(movement.sourceType).toBe('MATERIAL_ISSUE_LINE');
    expect(movement.sourceId).toBe(lineId);
    expect(movement.sourceKey).toBe(
      buildMaterialIssueLineStockSourceKey(lineId),
    );
    expect(movement.comment).toBe('Списание по документу расхода материалов');

    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A1.id },
    });
    expect(new Prisma.Decimal(balance.qty).toString()).toBe('16');

    // MaterialIssue.totalCost остался по MaterialIssueLine.unitCost
    // (4 × 999 = 3996) — stock OUT финансовую оценку не меняет.
    expect(new Prisma.Decimal(posted.body.totalCost).toString()).toBe('3996');
    const fromDb = await t.prisma.materialIssue.findUniqueOrThrow({
      where: { id: issueId },
    });
    expect(new Prisma.Decimal(fromDb.totalCost).toString()).toBe('3996');
  });

  // ===========================================================================
  // 3. DRAFT (только create) не создаёт StockMovement.
  // ===========================================================================

  test('MaterialIssue.create DRAFT не создаёт StockMovement', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
      cellId: seed.cells.A1.id,
    });
    const { issueId } = await createDraftIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '3',
      unitCost: '100',
    });
    expect(
      await t.prisma.stockMovement.count({
        where: { materialIssueId: issueId },
      }),
    ).toBe(0);
    // Остаток не тронут.
    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    expect(new Prisma.Decimal(balance.qty).toString()).toBe('10');
  });

  // ===========================================================================
  // 4. cancel DRAFT не создаёт StockMovement.
  // ===========================================================================

  test('MaterialIssue.cancel DRAFT не создаёт StockMovement', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
      cellId: seed.cells.A1.id,
    });
    const { issueId } = await createDraftIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '2',
      unitCost: '100',
    });
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/cancel`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'тест' })
      .expect(201);

    expect(
      await t.prisma.stockMovement.count({
        where: { materialIssueId: issueId },
      }),
    ).toBe(0);
  });

  // ===========================================================================
  // 5. POSTED cancel запрещён (сохранение MVP-контракта).
  // ===========================================================================

  test('POSTED MaterialIssue.cancel запрещён и не трогает склад', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
      cellId: seed.cells.A1.id,
    });
    const { issueId } = await createDraftIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '3',
      unitCost: '100',
      cellId: seed.cells.A1.id,
    });
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const cancel = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/cancel`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(409);
    expect(cancel.body.code).toBe('MATERIAL_ISSUE_POSTED_CANNOT_CANCEL');

    // После запрещённого cancel баланс не изменился (остался как
    // после post).
    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A1.id },
    });
    expect(new Prisma.Decimal(balance.qty).toString()).toBe('7');
  });

  // ===========================================================================
  // 6. Строка без workshopNeedId — soft-skip, post не падает.
  //    Ручной create требует description+unit, если workshopNeedId
  //    пустой — создаём такую строку явно.
  // ===========================================================================

  test('строка без workshopNeedId — soft-skip, остальные строки списываются, post проходит', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
      cellId: seed.cells.A1.id,
    });

    const created = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId: fx.orderId,
        lines: [
          {
            workshopNeedId: fx.workshopNeedId,
            issuedQty: '1',
            unitCost: '100',
          },
          {
            description: 'Ручной материал (нет WN)',
            unit: 'шт',
            issuedQty: '5',
            unitCost: '10',
          },
        ],
      })
      .expect(201);
    const issueId = created.body.id as string;

    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);

    // Только одно движение — по строке с workshopNeedId.
    const movements = await t.prisma.stockMovement.findMany({
      where: { materialIssueId: issueId },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.workshopNeedId).toBe(fx.workshopNeedId);
    expect(new Prisma.Decimal(movements[0]!.qty).toString()).toBe('1');
  });

  // ===========================================================================
  // 7. issuedQty <= 0 — soft-skip. POST-DTO валидирует qty > 0 на
  //    ручном create, поэтому проверяем прямой вызов
  //    `recordMaterialIssueInTx` с подменой qty в БД.
  // ===========================================================================

  test('строка с issuedQty <= 0 — soft-skip, StockMovement не пишется', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
      cellId: seed.cells.A1.id,
    });
    const { issueId, lineId } = await createDraftIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '2',
      unitCost: '100',
    });
    // Переводим документ в POSTED без stock OUT: обходим сервис и
    // подменяем qty на 0 уже после. Это приближено к «старый
    // документ / ручная правка данных».
    await t.prisma.materialIssue.update({
      where: { id: issueId },
      data: { status: 'POSTED', postedAt: new Date() },
    });
    await t.prisma.materialIssueLine.update({
      where: { id: lineId },
      data: { issuedQty: new Prisma.Decimal(0) },
    });

    await t.prisma.$transaction(async (tx) => {
      const created = await stock.recordMaterialIssueInTx(tx, issueId, null);
      expect(created).toHaveLength(0);
    });

    expect(
      await t.prisma.stockMovement.count({
        where: { materialIssueId: issueId },
      }),
    ).toBe(0);
  });

  // ===========================================================================
  // 8. explicit cellId → списываем из этой ячейки.
  // ===========================================================================

  test('MaterialIssueLine с explicit cellId списывает из этой ячейки', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
      cellId: seed.cells.A1.id,
    });
    const cellA1 = await t.prisma.cell.findUniqueOrThrow({
      where: { id: seed.cells.A1.id },
    });

    const { issueId, lineId } = await createDraftIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '3',
      unitCost: '100',
      cellId: seed.cells.A1.id,
    });
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const movement = await t.prisma.stockMovement.findFirstOrThrow({
      where: { materialIssueLineId: lineId },
    });
    expect(movement.cellId).toBe(seed.cells.A1.id);
    expect(movement.warehouseId).toBe(cellA1.warehouseId ?? null);
  });

  // ===========================================================================
  // 9. Без cellId — выбираем StockBalance с наибольшим qty > 0.
  // ===========================================================================

  test('MaterialIssueLine без cellId выбирает StockBalance с наибольшим положительным qty', async () => {
    const fx = await prepareConfirmedPo();
    // Два прихода в разные ячейки: A1 — 4, A2 — 7. Ожидаем OUT из A2.
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '4',
      cellId: seed.cells.A1.id,
    });
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '7',
      cellId: seed.cells.A2.id,
    });

    const { issueId, lineId } = await createDraftIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '2',
      unitCost: '100',
      cellId: null,
    });
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const movement = await t.prisma.stockMovement.findFirstOrThrow({
      where: { materialIssueLineId: lineId },
    });
    expect(movement.cellId).toBe(seed.cells.A2.id);

    const balanceA1 = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A1.id },
    });
    const balanceA2 = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A2.id },
    });
    expect(new Prisma.Decimal(balanceA1.qty).toString()).toBe('4');
    expect(new Prisma.Decimal(balanceA2.qty).toString()).toBe('5');
  });

  // ===========================================================================
  // 10. Нет положительных балансов — no-location balance, qty уходит в минус.
  // ===========================================================================

  test('если положительного StockBalance нет, создаётся no-location balance и qty уходит в минус', async () => {
    const fx = await prepareConfirmedPo();
    // Приёмки нет → StockBalance вообще отсутствует.

    const { issueId, lineId } = await createDraftIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '3',
      unitCost: '100',
    });
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const movement = await t.prisma.stockMovement.findFirstOrThrow({
      where: { materialIssueLineId: lineId },
    });
    expect(movement.warehouseId).toBeNull();
    expect(movement.cellId).toBeNull();

    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    expect(balance.warehouseId).toBeNull();
    expect(balance.cellId).toBeNull();
    expect(new Prisma.Decimal(balance.qty).toString()).toBe('-3');
  });

  // ===========================================================================
  // 12. Идемпотентность: повторный recordMaterialIssueInTx не пишет
  //     дубль OUT.
  // ===========================================================================

  test('повторная обработка MaterialIssue не создаёт дубль OUT (UNIQUE sourceKey)', async () => {
    const fx = await prepareConfirmedPo();
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
      cellId: seed.cells.A1.id,
    });
    const { issueId, lineId } = await createDraftIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '2',
      unitCost: '100',
      cellId: seed.cells.A1.id,
    });
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);

    await t.prisma.$transaction(async (tx) => {
      const second = await stock.recordMaterialIssueInTx(tx, issueId, null);
      expect(second).toHaveLength(1);
      expect(second[0]!.sourceKey).toBe(
        buildMaterialIssueLineStockSourceKey(lineId),
      );
    });

    expect(
      await t.prisma.stockMovement.count({
        where: { materialIssueLineId: lineId },
      }),
    ).toBe(1);
    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A1.id },
    });
    expect(new Prisma.Decimal(balance.qty).toString()).toBe('8');
  });

  // ===========================================================================
  // 13. OUT использует balance.unitCost, а не MaterialIssueLine.unitCost.
  //     Приёмка задаёт balance.unitCost = 500 (RUB-цена), ручная
  //     строка — unitCost = 999; OUT должен пойти с 500.
  // ===========================================================================

  test('StockMovement OUT использует balance.unitCost, а не MaterialIssueLine.unitCost', async () => {
    const fx = await prepareConfirmedPo({ price: '500.00' });
    await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
      cellId: seed.cells.A1.id,
    });
    const { issueId, lineId } = await createDraftIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '3',
      unitCost: '999', // «финансовая» цена — для MaterialIssue.totalCost.
      cellId: seed.cells.A1.id,
    });
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const movement = await t.prisma.stockMovement.findFirstOrThrow({
      where: { materialIssueLineId: lineId },
    });
    expect(new Prisma.Decimal(movement.unitCost).toString()).toBe('500');
    expect(new Prisma.Decimal(movement.totalCost).toString()).toBe('1500');

    // Документ остаётся со «своей» unitCost = 999.
    const line = await t.prisma.materialIssueLine.findUniqueOrThrow({
      where: { id: lineId },
    });
    expect(new Prisma.Decimal(line.unitCost).toString()).toBe('999');
    expect(new Prisma.Decimal(line.totalCost).toString()).toBe('2997');
  });

  // ===========================================================================
  // 15, 16. AUTO_CUT_ISSUE через MaterialIssuesService пишет OUT и
  //         не блокирует выдачу кроя даже при отсутствии остатка.
  // ===========================================================================

  test('AUTO_CUT_ISSUE создаёт StockMovement OUT через MaterialIssuesService и не блокирует issueToEmployee при нулевом остатке', async () => {
    // Включаем автосписание и НЕ создаём приёмку — StockBalance пуст.
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        singleton: true,
        autoIssueMaterialsOnCutRelease: true,
      },
      update: { autoIssueMaterialsOnCutRelease: true },
    });

    const fx = await prepareConfirmedPo({ qtyPlan: 10 });
    // Покрасить quotedPrice RUB для auto unitCost (не влияет на OUT —
    // OUT использует balance.unitCost = 0).
    await t.prisma.workshopNeed.update({
      where: { id: fx.workshopNeedId },
      data: { quotedPrice: new Prisma.Decimal(100), quotedCurrency: 'RUB' },
    });

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
        qtyCut: 4,
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
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    // issueToEmployee должен пройти даже при нулевом остатке.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passport.body.id}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const auto = await t.prisma.materialIssue.findFirstOrThrow({
      where: { passportId: passport.body.id, source: 'AUTO_CUT_ISSUE' },
      include: { lines: true },
    });
    expect(auto.status).toBe('POSTED');
    expect(auto.lines.length).toBeGreaterThan(0);

    // OUT-движения записаны.
    const movements = await t.prisma.stockMovement.findMany({
      where: { materialIssueId: auto.id },
    });
    expect(movements).toHaveLength(auto.lines.length);
    for (const m of movements) {
      expect(m.direction).toBe('OUT');
      expect(m.type).toBe('MATERIAL_ISSUE');
      expect(m.comment).toBe('Автоматическое списание при выдаче кроя');
    }

    // Баланс ушёл в минус по сумме issuedQty (точно по формуле
    // ТЗ §5 и §6 «no-location negative balance»).
    const totalIssued = auto.lines.reduce(
      (acc, l) => acc.add(new Prisma.Decimal(l.issuedQty)),
      new Prisma.Decimal(0),
    );
    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId },
    });
    expect(new Prisma.Decimal(balance.qty).toString()).toBe(
      totalIssued.mul(-1).toString(),
    );
  });

  // ===========================================================================
  // Дополнительно: приёмочный IN-ключ не пересекается с OUT-ключом
  //                (`PURCHASE_RECEIPT_LINE:*` vs `MATERIAL_ISSUE_LINE:*`).
  //                Гарантирует, что UNIQUE sourceKey не даст ложных
  //                коллизий.
  // ===========================================================================

  test('PURCHASE_RECEIPT_LINE и MATERIAL_ISSUE_LINE ключи не пересекаются', async () => {
    const fx = await prepareConfirmedPo();
    const { receiptLineId } = await createPostedReceipt({
      purchaseOrderId: fx.purchaseOrderId,
      purchaseOrderLineId: fx.purchaseOrderLineId,
      receivedQty: '10',
      cellId: seed.cells.A1.id,
    });
    const { issueId, lineId } = await createDraftIssue({
      orderId: fx.orderId,
      workshopNeedId: fx.workshopNeedId,
      issuedQty: '1',
      unitCost: '1',
      cellId: seed.cells.A1.id,
    });
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const inKey = buildPurchaseReceiptLineStockSourceKey(receiptLineId);
    const outKey = buildMaterialIssueLineStockSourceKey(lineId);
    expect(inKey.startsWith('PURCHASE_RECEIPT_LINE:')).toBe(true);
    expect(outKey.startsWith('MATERIAL_ISSUE_LINE:')).toBe(true);
    expect(inKey).not.toEqual(outKey);

    const byIn = await t.prisma.stockMovement.findFirstOrThrow({
      where: { sourceKey: inKey },
    });
    const byOut = await t.prisma.stockMovement.findFirstOrThrow({
      where: { sourceKey: outKey },
    });
    expect(byIn.direction).toBe('IN');
    expect(byOut.direction).toBe('OUT');
  });
});
