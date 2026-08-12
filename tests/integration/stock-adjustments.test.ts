/**
 * Integration-тесты ручной корректировки остатка
 * (`POST /api/stock/adjustments`, см.
 *  `apps/api/src/modules/stock/stock.controller.ts`,
 *  `apps/api/src/modules/stock/stock.service.ts::createAdjustment`,
 *  `apps/api/src/modules/stock/dto/create-stock-adjustment.dto.ts`,
 *  `prisma/schema.prisma::CompanySettings.allowNegativeMaterialStock`,
 *  `docs/api.md §«26a.3 POST /api/stock/adjustments»`,
 *  `docs/current-state.md §«Ручная корректировка остатка»`).
 *
 * Покрытие (порядок совпадает с ТЗ §14 «Tests»):
 *
 *   1. POST /api/stock/adjustments IN создаёт StockMovement ADJUSTMENT IN.
 *   2. IN увеличивает StockBalance.qty.
 *   3. IN использует unitCost из body (средневзвешенная пересчитывается).
 *   4. OUT создаёт StockMovement ADJUSTMENT OUT.
 *   5. OUT уменьшает StockBalance.qty.
 *   6. OUT использует текущий balance.unitCost, не body.unitCost.
 *   7. allowNegativeMaterialStock=false + OUT > qty → 409
 *      MATERIAL_STOCK_INSUFFICIENT, баланс не меняется, движение не создано.
 *   8. allowNegativeMaterialStock=true + OUT > qty → баланс уходит в минус.
 *   9. Повтор с тем же clientRequestId не создаёт дубль.
 *  10. sourceKey не возвращается в response.
 *  11. comment обязателен (400 VALIDATION_ERROR при отсутствии).
 *  12. SEAMSTRESS не имеет доступа (403 FORBIDDEN_ROLE).
 *
 * Без `TEST_DATABASE_URL` `describeWithDb` превращается в
 * `describe.skip` (как и в `tests/integration/stock-readonly-api.test.ts`).
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

const COMPANY_SETTINGS_ID = 'default';

describeWithDb('integration — stock adjustments (manual)', () => {
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
  // helpers — подняем приёмку через публичные эндпоинты, чтобы получить
  // реальный `StockBalance` с положительным qty и средней ценой.
  // ---------------------------------------------------------------------------

  async function preparedBalance(
    receivedQty = '10',
    price = '500.00',
  ): Promise<{
    orderId: string;
    workshopNeedId: string;
    stockBalanceId: string;
  }> {
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
            cellId: seed.cells.A1.id,
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
    };
  }

  // ===========================================================================
  // 1. IN создаёт ADJUSTMENT IN.
  // ===========================================================================

  test('POST /api/stock/adjustments (IN) создаёт StockMovement ADJUSTMENT IN', async () => {
    const fx = await preparedBalance('10');

    const res = await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'IN',
        qty: '3',
        unitCost: '600.00',
        comment: 'Излишки при инвентаризации',
        clientRequestId: `t1-${Date.now()}`,
      })
      .expect(201);

    expect(res.body.type).toBe('ADJUSTMENT');
    expect(res.body.direction).toBe('IN');
    expect(res.body.qty).toBe('3');
    expect(res.body.comment).toBe('Излишки при инвентаризации');
  });

  // ===========================================================================
  // 2. IN увеличивает StockBalance.qty.
  // ===========================================================================

  test('IN увеличивает StockBalance.qty', async () => {
    const fx = await preparedBalance('10');

    await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'IN',
        qty: '4',
        comment: 'Доприход',
        clientRequestId: `t2-${Date.now()}`,
      })
      .expect(201);

    const balance = await t.prisma.stockBalance.findUniqueOrThrow({
      where: { id: fx.stockBalanceId },
    });
    expect(balance.qty.toString()).toBe('14');
  });

  // ===========================================================================
  // 3. IN использует unitCost из body (новая средневзвешенная).
  // ===========================================================================

  test('IN использует unitCost из body, средневзвешенная пересчитывается', async () => {
    const fx = await preparedBalance('10', '500.00'); // total 5000, unit 500
    // IN +10 по 700 → итого 20 шт, totalCost = 5000 + 7000 = 12000,
    // средняя 600.
    await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'IN',
        qty: '10',
        unitCost: '700.00',
        comment: 'Поступление по другой цене',
        clientRequestId: `t3-${Date.now()}`,
      })
      .expect(201);

    const balance = await t.prisma.stockBalance.findUniqueOrThrow({
      where: { id: fx.stockBalanceId },
    });
    expect(balance.qty.toString()).toBe('20');
    expect(new Prisma.Decimal(balance.unitCost).eq(new Prisma.Decimal('600'))).toBe(true);
  });

  // ===========================================================================
  // 4. OUT создаёт ADJUSTMENT OUT.
  // ===========================================================================

  test('POST /api/stock/adjustments (OUT) создаёт StockMovement ADJUSTMENT OUT', async () => {
    const fx = await preparedBalance('10');

    const res = await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'OUT',
        qty: '2',
        comment: 'Списание брака',
        clientRequestId: `t4-${Date.now()}`,
      })
      .expect(201);

    expect(res.body.type).toBe('ADJUSTMENT');
    expect(res.body.direction).toBe('OUT');
    expect(res.body.qty).toBe('2');
  });

  // ===========================================================================
  // 5. OUT уменьшает StockBalance.qty.
  // ===========================================================================

  test('OUT уменьшает StockBalance.qty', async () => {
    const fx = await preparedBalance('10');

    await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'OUT',
        qty: '3',
        comment: 'Списание',
        clientRequestId: `t5-${Date.now()}`,
      })
      .expect(201);

    const balance = await t.prisma.stockBalance.findUniqueOrThrow({
      where: { id: fx.stockBalanceId },
    });
    expect(balance.qty.toString()).toBe('7');
  });

  // ===========================================================================
  // 6. OUT использует текущий balance.unitCost, не body.unitCost.
  // ===========================================================================

  test('OUT использует balance.unitCost, body.unitCost игнорируется', async () => {
    const fx = await preparedBalance('10', '500.00');

    const res = await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'OUT',
        qty: '2',
        // Сознательно «вредное» значение — backend должен его проигнорировать.
        unitCost: '99999.99',
        comment: 'Списание по складской цене',
        clientRequestId: `t6-${Date.now()}`,
      })
      .expect(201);

    // movement.unitCost совпадает с balance.unitCost (=500), а не 99999.99.
    expect(res.body.unitCost).toBe('500');
    expect(res.body.totalCost).toBe('1000');
  });

  // ===========================================================================
  // 7. allowNegativeMaterialStock=false + OUT > qty → 409.
  // ===========================================================================

  test('allowNegativeMaterialStock=false + OUT > qty → 409 MATERIAL_STOCK_INSUFFICIENT', async () => {
    const fx = await preparedBalance('5');

    await t.prisma.companySettings.upsert({
      where: { id: COMPANY_SETTINGS_ID },
      update: { allowNegativeMaterialStock: false },
      create: { id: COMPANY_SETTINGS_ID, allowNegativeMaterialStock: false },
    });

    const before = await t.prisma.stockBalance.findUniqueOrThrow({
      where: { id: fx.stockBalanceId },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'OUT',
        qty: '10',
        comment: 'Большое списание',
        clientRequestId: `t7-${Date.now()}`,
      })
      .expect(409);
    expect(res.body.code).toBe('MATERIAL_STOCK_INSUFFICIENT');

    const after = await t.prisma.stockBalance.findUniqueOrThrow({
      where: { id: fx.stockBalanceId },
    });
    expect(after.qty.toString()).toBe(before.qty.toString());

    const movements = await t.prisma.stockMovement.findMany({
      where: { stockBalanceId: fx.stockBalanceId, type: 'ADJUSTMENT' },
    });
    expect(movements).toHaveLength(0);
  });

  // ===========================================================================
  // 8. allowNegativeMaterialStock=true + OUT > qty → минус.
  // ===========================================================================

  test('allowNegativeMaterialStock=true + OUT > qty → баланс в минус', async () => {
    const fx = await preparedBalance('5');

    await t.prisma.companySettings.upsert({
      where: { id: COMPANY_SETTINGS_ID },
      update: { allowNegativeMaterialStock: true },
      create: { id: COMPANY_SETTINGS_ID, allowNegativeMaterialStock: true },
    });

    await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'OUT',
        qty: '8',
        comment: 'Списание сверх остатка',
        clientRequestId: `t8-${Date.now()}`,
      })
      .expect(201);

    const balance = await t.prisma.stockBalance.findUniqueOrThrow({
      where: { id: fx.stockBalanceId },
    });
    expect(new Prisma.Decimal(balance.qty).eq(new Prisma.Decimal('-3'))).toBe(true);
  });

  // ===========================================================================
  // 9. Идемпотентность по clientRequestId.
  // ===========================================================================

  test('повторный submit с тем же clientRequestId возвращает существующее движение', async () => {
    const fx = await preparedBalance('10');
    const clientRequestId = `idem-${Date.now()}`;

    const first = await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'IN',
        qty: '2',
        unitCost: '500.00',
        comment: 'Идемпотентный приход',
        clientRequestId,
      })
      .expect(201);

    const second = await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'IN',
        qty: '2',
        unitCost: '500.00',
        comment: 'Идемпотентный приход',
        clientRequestId,
      })
      .expect(201);

    expect(second.body.id).toBe(first.body.id);

    const balance = await t.prisma.stockBalance.findUniqueOrThrow({
      where: { id: fx.stockBalanceId },
    });
    // qty увеличен ровно один раз (10 + 2 = 12), а не дважды.
    expect(balance.qty.toString()).toBe('12');

    const movements = await t.prisma.stockMovement.findMany({
      where: { stockBalanceId: fx.stockBalanceId, type: 'ADJUSTMENT' },
    });
    expect(movements).toHaveLength(1);
  });

  // ===========================================================================
  // 10. sourceKey не возвращается в response.
  // ===========================================================================

  test('sourceKey не отдаётся в response', async () => {
    const fx = await preparedBalance('10');
    const res = await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'IN',
        qty: '1',
        comment: 'Без sourceKey',
        clientRequestId: `t10-${Date.now()}`,
      })
      .expect(201);
    expect(res.body).not.toHaveProperty('sourceKey');

    // Но в БД sourceKey есть с префиксом STOCK_ADJUSTMENT:
    const m = await t.prisma.stockMovement.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(m.sourceKey?.startsWith('STOCK_ADJUSTMENT:')).toBe(true);
  });

  // ===========================================================================
  // 11. comment обязателен.
  // ===========================================================================

  test('comment обязателен (400 VALIDATION_ERROR)', async () => {
    const fx = await preparedBalance('10');
    const res = await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'IN',
        qty: '1',
        clientRequestId: `t11-${Date.now()}`,
      })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // ===========================================================================
  // 12. SEAMSTRESS — 403.
  // ===========================================================================

  test('SEAMSTRESS не имеет доступа к POST /api/stock/adjustments (403)', async () => {
    const fx = await preparedBalance('10');
    const res = await request(t.app.getHttpServer())
      .post('/api/stock/adjustments')
      .set('Cookie', cookies.seamstress)
      .send({
        stockBalanceId: fx.stockBalanceId,
        direction: 'IN',
        qty: '1',
        comment: 'попытка швеи',
        clientRequestId: `t12-${Date.now()}`,
      })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });
});
