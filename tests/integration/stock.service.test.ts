/**
 * Integration-тесты foundation `StockService` (`StockBalance` /
 * `StockMovement`). Бизнес-потоки приёмки / расхода сюда не
 * подключены — проверяем только сервис и Prisma-слой.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import {
  STOCK_MOVEMENT_DIRECTION,
  STOCK_MOVEMENT_TYPE,
} from '@sewing/api/modules/stock/stock.constants';
import { StockService } from '@sewing/api/modules/stock/stock.service';
import {
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — StockService (foundation)', () => {
  let t: TestApp;
  let seed: SeedResult;
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
  });

  async function createOrderWithNeed(): Promise<{
    orderId: string;
    workshopNeedId: string;
  }> {
    const order = await t.prisma.order.create({
      data: {
        number: `STK-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: new Date(),
        status: 'DRAFT',
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M,
            qtyPlan: 10,
          },
        },
      },
    });
    const need = await t.prisma.workshopNeed.create({
      data: {
        orderId: order.id,
        description: 'Ткань тест',
        calculatedQty: new Prisma.Decimal(100),
        unit: 'кг',
      },
    });
    return { orderId: order.id, workshopNeedId: need.id };
  }

  test('getOrCreateBalanceInTx создаёт баланс', async () => {
    const { workshopNeedId } = await createOrderWithNeed();
    await t.prisma.$transaction(async (tx) => {
      const b = await stock.getOrCreateBalanceInTx(tx, {
        workshopNeedId,
        warehouseId: null,
        cellId: null,
        description: 'Ткань тест',
        materialRole: 'MAIN_FABRIC',
        unit: 'кг',
      });
      expect(b.qty.toString()).toBe('0');
      expect(b.unit).toBe('кг');
      expect(b.balanceKey).toContain(workshopNeedId);
    });
    const rows = await t.prisma.stockBalance.findMany({
      where: { workshopNeedId },
    });
    expect(rows).toHaveLength(1);
  });

  test('getOrCreateBalanceInTx повторно возвращает тот же balance', async () => {
    const { workshopNeedId } = await createOrderWithNeed();
    let first = '';
    await t.prisma.$transaction(async (tx) => {
      const a = await stock.getOrCreateBalanceInTx(tx, {
        workshopNeedId,
        warehouseId: null,
        cellId: null,
        description: 'Ткань тест',
        unit: 'кг',
      });
      first = a.id;
      const b = await stock.getOrCreateBalanceInTx(tx, {
        workshopNeedId,
        warehouseId: null,
        cellId: null,
        description: 'другое',
        unit: 'кг',
      });
      expect(b.id).toBe(first);
    });
    const count = await t.prisma.stockBalance.count({
      where: { workshopNeedId },
    });
    expect(count).toBe(1);
  });

  test('IN movement увеличивает qty', async () => {
    const { workshopNeedId } = await createOrderWithNeed();
    await t.prisma.$transaction(async (tx) => {
      const { balance } = await stock.applyMovementInTx(tx, {
        workshopNeedId,
        warehouseId: null,
        cellId: null,
        description: 'Ткань тест',
        type: STOCK_MOVEMENT_TYPE.ADJUSTMENT,
        direction: STOCK_MOVEMENT_DIRECTION.IN,
        qty: new Prisma.Decimal(5),
        unit: 'кг',
        unitCost: new Prisma.Decimal(100),
      });
      expect(balance.qty.toString()).toBe('5');
      expect(balance.totalCost.toString()).toBe('500');
    });
  });

  test('OUT movement уменьшает qty', async () => {
    const { workshopNeedId } = await createOrderWithNeed();
    await t.prisma.$transaction(async (tx) => {
      await stock.applyMovementInTx(tx, {
        workshopNeedId,
        description: 'Ткань тест',
        type: STOCK_MOVEMENT_TYPE.ADJUSTMENT,
        direction: STOCK_MOVEMENT_DIRECTION.IN,
        qty: new Prisma.Decimal(10),
        unit: 'кг',
        unitCost: new Prisma.Decimal(20),
      });
      const { balance } = await stock.applyMovementInTx(tx, {
        workshopNeedId,
        description: 'Ткань тест',
        type: STOCK_MOVEMENT_TYPE.MATERIAL_ISSUE,
        direction: STOCK_MOVEMENT_DIRECTION.OUT,
        qty: new Prisma.Decimal(3),
        unit: 'кг',
        unitCost: new Prisma.Decimal(0),
      });
      expect(balance.qty.toString()).toBe('7');
    });
  });

  test('OUT может дать отрицательный qty (foundation)', async () => {
    const { workshopNeedId } = await createOrderWithNeed();
    await t.prisma.$transaction(async (tx) => {
      const { balance } = await stock.applyMovementInTx(tx, {
        workshopNeedId,
        description: 'Ткань тест',
        type: STOCK_MOVEMENT_TYPE.MATERIAL_ISSUE,
        direction: STOCK_MOVEMENT_DIRECTION.OUT,
        qty: new Prisma.Decimal(1),
        unit: 'кг',
        unitCost: new Prisma.Decimal(0),
      });
      expect(balance.qty.lt(0)).toBe(true);
    });
  });

  test('unit mismatch → ошибка', async () => {
    const { workshopNeedId } = await createOrderWithNeed();
    await expect(
      t.prisma.$transaction(async (tx) => {
        await stock.getOrCreateBalanceInTx(tx, {
          workshopNeedId,
          description: 'Ткань тест',
          unit: 'кг',
        });
        await stock.applyMovementInTx(tx, {
          workshopNeedId,
          description: 'Ткань тест',
          type: STOCK_MOVEMENT_TYPE.ADJUSTMENT,
          direction: STOCK_MOVEMENT_DIRECTION.IN,
          qty: new Prisma.Decimal(1),
          unit: 'м',
          unitCost: new Prisma.Decimal(1),
        });
      }),
    ).rejects.toThrow(/STOCK_BALANCE_UNIT_MISMATCH|Единиц/);
  });

  test('movement пишет balanceBeforeQty и balanceAfterQty', async () => {
    const { workshopNeedId } = await createOrderWithNeed();
    await t.prisma.$transaction(async (tx) => {
      const { movement } = await stock.applyMovementInTx(tx, {
        workshopNeedId,
        description: 'Ткань тест',
        type: STOCK_MOVEMENT_TYPE.ADJUSTMENT,
        direction: STOCK_MOVEMENT_DIRECTION.IN,
        qty: new Prisma.Decimal(2),
        unit: 'кг',
        unitCost: new Prisma.Decimal(50),
      });
      expect(movement.balanceBeforeQty?.toString()).toBe('0');
      expect(movement.balanceAfterQty?.toString()).toBe('2');
    });
  });

  test('movement сохраняет sourceType и sourceId', async () => {
    const { workshopNeedId } = await createOrderWithNeed();
    await t.prisma.$transaction(async (tx) => {
      const { movement } = await stock.applyMovementInTx(tx, {
        workshopNeedId,
        description: 'Ткань тест',
        type: STOCK_MOVEMENT_TYPE.ADJUSTMENT,
        direction: STOCK_MOVEMENT_DIRECTION.IN,
        qty: new Prisma.Decimal(1),
        unit: 'кг',
        unitCost: new Prisma.Decimal(1),
        sourceType: 'MANUAL_TEST',
        sourceId: 'src-42',
      });
      expect(movement.sourceType).toBe('MANUAL_TEST');
      expect(movement.sourceId).toBe('src-42');
    });
  });

  test('movement сохраняет purchaseReceiptLineId при переданном FK', async () => {
    const { workshopNeedId } = await createOrderWithNeed();
    const supplier = await t.prisma.supplier.create({
      data: { name: `Sup-${Date.now()}`, status: 'ACTIVE' },
    });
    const po = await t.prisma.purchaseOrder.create({
      data: {
        number: `PO-STK-${Date.now()}`,
        supplierId: supplier.id,
        supplierNameSnapshot: supplier.name,
        status: 'CONFIRMED',
        lines: {
          create: {
            workshopNeedId,
            itemNameSnapshot: 'Item',
            unitSnapshot: 'кг',
            qty: new Prisma.Decimal(10),
            status: 'CONFIRMED',
          },
        },
      },
      include: { lines: true },
    });
    const pol = po.lines[0]!;
    const pr = await t.prisma.purchaseReceipt.create({
      data: {
        number: `PR-STK-${Date.now()}`,
        purchaseOrderId: po.id,
        status: 'POSTED',
        lines: {
          create: {
            purchaseOrderLineId: pol.id,
            workshopNeedId,
            itemNameSnapshot: 'Item',
            unitSnapshot: 'кг',
            receivedQty: new Prisma.Decimal(1),
            unit: 'кг',
            status: 'POSTED',
          },
        },
      },
      include: { lines: true },
    });
    const prLine = pr.lines[0]!;

    await t.prisma.$transaction(async (tx) => {
      const { movement } = await stock.applyMovementInTx(tx, {
        workshopNeedId,
        description: 'Ткань тест',
        type: STOCK_MOVEMENT_TYPE.PURCHASE_RECEIPT,
        direction: STOCK_MOVEMENT_DIRECTION.IN,
        qty: new Prisma.Decimal(1),
        unit: 'кг',
        unitCost: new Prisma.Decimal(10),
        purchaseReceiptId: pr.id,
        purchaseReceiptLineId: prLine.id,
      });
      expect(movement.purchaseReceiptLineId).toBe(prLine.id);
      expect(movement.purchaseReceiptId).toBe(pr.id);
    });
  });

  test('movement сохраняет materialIssueLineId при переданном FK', async () => {
    const { orderId, workshopNeedId } = await createOrderWithNeed();
    const issue = await t.prisma.materialIssue.create({
      data: {
        orderId,
        status: 'DRAFT',
        lines: {
          create: {
            workshopNeedId,
            description: 'Ткань тест',
            unit: 'кг',
            issuedQty: new Prisma.Decimal(1),
            unitCost: new Prisma.Decimal(10),
            totalCost: new Prisma.Decimal(10),
          },
        },
      },
      include: { lines: true },
    });
    const line = issue.lines[0]!;

    await t.prisma.$transaction(async (tx) => {
      const { movement } = await stock.applyMovementInTx(tx, {
        workshopNeedId,
        description: 'Ткань тест',
        type: STOCK_MOVEMENT_TYPE.MATERIAL_ISSUE,
        direction: STOCK_MOVEMENT_DIRECTION.OUT,
        qty: new Prisma.Decimal(1),
        unit: 'кг',
        unitCost: new Prisma.Decimal(0),
        materialIssueId: issue.id,
        materialIssueLineId: line.id,
      });
      expect(movement.materialIssueLineId).toBe(line.id);
      expect(movement.materialIssueId).toBe(issue.id);
    });
  });

  test('balanceKey защищает от дублей при null warehouseId/cellId', async () => {
    const { workshopNeedId } = await createOrderWithNeed();
    await t.prisma.$transaction(async (tx) => {
      await stock.getOrCreateBalanceInTx(tx, {
        workshopNeedId,
        warehouseId: null,
        cellId: null,
        description: 'A',
        unit: 'кг',
      });
      await stock.getOrCreateBalanceInTx(tx, {
        workshopNeedId,
        warehouseId: null,
        cellId: null,
        description: 'B',
        unit: 'кг',
      });
    });
    const n = await t.prisma.stockBalance.count({ where: { workshopNeedId } });
    expect(n).toBe(1);
  });

  test('MaterialIssuesService подключён к StockService (recordMaterialIssueInTx)', () => {
    const root = join(__dirname, '../../apps/api/src/modules');
    const mi = readFileSync(
      join(root, 'material-issues/material-issues.service.ts'),
      'utf8',
    );
    expect(mi).toMatch(/\bStockService\b/);
    expect(mi).toMatch(/recordMaterialIssueInTx/);
  });

  test('PurchaseReceiptsService подключён к StockService (recordPurchaseReceiptInTx + reversePurchaseReceiptInTx)', () => {
    const root = join(__dirname, '../../apps/api/src/modules');
    const pr = readFileSync(
      join(root, 'purchase-receipts/purchase-receipts.service.ts'),
      'utf8',
    );
    expect(pr).toMatch(/\bStockService\b/);
    expect(pr).toMatch(/recordPurchaseReceiptInTx/);
    expect(pr).toMatch(/reversePurchaseReceiptInTx/);
  });
});
