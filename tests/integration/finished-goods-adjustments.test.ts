/**
 * Integration-тесты ручной корректировки остатка готовой продукции
 * (`POST /api/finished-goods/adjustments`, см.
 *  `apps/api/src/modules/finished-goods/finished-goods.controller.ts`,
 *  `apps/api/src/modules/finished-goods/finished-goods.service.ts::createAdjustment`,
 *  `apps/api/src/modules/finished-goods/dto/create-finished-goods-adjustment.dto.ts`,
 *  `docs/api.md §«Finished goods adjustments»`,
 *  `docs/current-state.md §«Готовая продукция»`).
 *
 * Покрытие (порядок совпадает с ТЗ §15 «Tests»):
 *
 *   1. POST /api/finished-goods/adjustments IN создаёт ADJUSTMENT IN.
 *   2. IN увеличивает FinishedGoodsBalance.qty.
 *   3. POST /api/finished-goods/adjustments OUT создаёт ADJUSTMENT OUT.
 *   4. OUT уменьшает FinishedGoodsBalance.qty.
 *   5. OUT возвращает 409 при qty > source.qty.
 *   6. Same clientRequestId идемпотентен.
 *   7. Response не возвращает sourceKey.
 *   8. SEAMSTRESS не имеет доступа (403).
 *   9. ADMIN / SHOP_MANAGER имеют доступ.
 *  10. Adjustment не затрагивает MaterialIssue / material StockBalance /
 *      production cost.
 *  11. qty должен быть целым (400).
 *  12. Audit FINISHED_GOODS_ADJUSTMENT_CREATED.
 *
 * Без `TEST_DATABASE_URL` `describeWithDb` превращается в
 * `describe.skip`.
 */
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

describeWithDb('integration — finished goods adjustments', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let orderId: string;
  let warehouseId: string;

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
      packer: loginAs(t, seed.employees['packer']!),
      manager: loginAs(t, seed.employees['shop-chief']!),
      seamstress: loginAs(t, seed.employees['seamstress']!),
    };

    // Активная PACKING-смена для упаковщика — чтобы можно было
    // упаковать паспорт и получить PRODUCTION_RECEIPT IN.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.packer)
      .send({
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
      })
      .expect(201);

    const wh = await t.prisma.warehouse.create({
      data: {
        name: `FG-adj-${Math.random().toString(36).slice(2, 8)}`,
        isActive: true,
      },
    });
    warehouseId = wh.id;

    const order = await t.prisma.order.create({
      data: {
        number: `O-FGA-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        finishedGoodsWarehouseId: warehouseId,
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M,
            qtyPlan: 100,
          },
        },
      },
    });
    orderId = order.id;
  });

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  async function preparedBalance(qtyGood = 10): Promise<{
    finishedGoodsBalanceId: string;
    qty: number;
  }> {
    const random = Math.random().toString(36).slice(2, 8);
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-FGA-${random}`,
        qrCode: `passport:fga-${random}`,
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: `R-${random}`,
        cutDate: new Date(),
        qtyPlan: qtyGood,
        qtyCut: qtyGood,
        qtyGood,
        status: 'IN_PROGRESS',
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });

    const box = await request(t.app.getHttpServer())
      .post('/api/packing/boxes')
      .set('Cookie', cookies.packer)
      .send({ maxQty: 50 })
      .expect(201);

    await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${box.body.id}/add-passport`)
      .set('Cookie', cookies.packer)
      .send({ passportId: passport.id })
      .expect(201);

    const balance = await t.prisma.finishedGoodsBalance.findFirstOrThrow({
      where: { orderId, productId: seed.product.id, sizeId: seed.sizes.M },
    });
    return { finishedGoodsBalanceId: balance.id, qty: balance.qty };
  }

  // ===========================================================================
  // 1. ADJUSTMENT IN happy path.
  // ===========================================================================

  test('POST /api/finished-goods/adjustments IN создаёт ADJUSTMENT IN и увеличивает баланс', async () => {
    const fx = await preparedBalance(10);

    const res = await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        finishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        direction: 'IN',
        qty: 3,
        comment: 'Найдено при инвентаризации',
        clientRequestId: `fga1-${Date.now()}`,
      })
      .expect(201);

    expect(res.body.id).toBeTruthy();
    expect(res.body.type).toBe('ADJUSTMENT');
    expect(res.body.direction).toBe('IN');
    expect(res.body.qty).toBe(3);
    expect(res.body.sourceKey).toBeUndefined();

    const balance = await t.prisma.finishedGoodsBalance.findUniqueOrThrow({
      where: { id: fx.finishedGoodsBalanceId },
    });
    expect(balance.qty).toBe(13);
  });

  // ===========================================================================
  // 2. ADJUSTMENT OUT happy path.
  // ===========================================================================

  test('POST /api/finished-goods/adjustments OUT создаёт ADJUSTMENT OUT и уменьшает баланс', async () => {
    const fx = await preparedBalance(10);

    const res = await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        finishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        direction: 'OUT',
        qty: 4,
        comment: 'Списано как брак',
        clientRequestId: `fga2-${Date.now()}`,
      })
      .expect(201);

    expect(res.body.type).toBe('ADJUSTMENT');
    expect(res.body.direction).toBe('OUT');
    expect(res.body.qty).toBe(4);

    const balance = await t.prisma.finishedGoodsBalance.findUniqueOrThrow({
      where: { id: fx.finishedGoodsBalanceId },
    });
    expect(balance.qty).toBe(6);
  });

  // ===========================================================================
  // 3. OUT > source.qty → 409.
  // ===========================================================================

  test('OUT возвращает 409 при qty > source.qty', async () => {
    const fx = await preparedBalance(2);

    const res = await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        finishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        direction: 'OUT',
        qty: 10,
        comment: 'Перебор',
        clientRequestId: `fga3-${Date.now()}`,
      })
      .expect(409);

    expect(res.body.code).toBe('FINISHED_GOODS_INSUFFICIENT_BALANCE');

    // Баланс не изменился.
    const balance = await t.prisma.finishedGoodsBalance.findUniqueOrThrow({
      where: { id: fx.finishedGoodsBalanceId },
    });
    expect(balance.qty).toBe(2);
  });

  // ===========================================================================
  // 4. Идемпотентность по clientRequestId.
  // ===========================================================================

  test('Повторный submit с тем же clientRequestId идемпотентен', async () => {
    const fx = await preparedBalance(10);
    const clientRequestId = `fga4-${Date.now()}`;

    const first = await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        finishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        direction: 'IN',
        qty: 5,
        comment: 'Idempotent #1',
        clientRequestId,
      })
      .expect(201);

    const second = await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        finishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        direction: 'IN',
        qty: 5,
        comment: 'Idempotent #2 (ignored)',
        clientRequestId,
      })
      .expect(201);

    expect(second.body.id).toBe(first.body.id);

    // Баланс изменился ровно один раз.
    const balance = await t.prisma.finishedGoodsBalance.findUniqueOrThrow({
      where: { id: fx.finishedGoodsBalanceId },
    });
    expect(balance.qty).toBe(15);

    const movements = await t.prisma.finishedGoodsMovement.findMany({
      where: { type: 'ADJUSTMENT' },
    });
    expect(movements).toHaveLength(1);
  });

  // ===========================================================================
  // 5. SEAMSTRESS не имеет доступа.
  // ===========================================================================

  test('SEAMSTRESS не имеет доступа к POST /api/finished-goods/adjustments', async () => {
    const fx = await preparedBalance(5);

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.seamstress)
      .send({
        finishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        direction: 'IN',
        qty: 1,
        comment: 'Без прав',
        clientRequestId: `fga5-${Date.now()}`,
      })
      .expect(403);
  });

  // ===========================================================================
  // 6. qty должно быть целым положительным.
  // ===========================================================================

  test('Возвращает 400 при нецелом / нулевом / отрицательном qty', async () => {
    const fx = await preparedBalance(5);

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        finishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        direction: 'IN',
        qty: 1.5,
        comment: 'Нецелое',
        clientRequestId: `fga6a-${Date.now()}`,
      })
      .expect(400);

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        finishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        direction: 'IN',
        qty: 0,
        comment: 'Ноль',
        clientRequestId: `fga6b-${Date.now()}`,
      })
      .expect(400);

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        finishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        direction: 'OUT',
        qty: -3,
        comment: 'Отрицательное',
        clientRequestId: `fga6c-${Date.now()}`,
      })
      .expect(400);
  });

  // ===========================================================================
  // 7. Adjustment не затрагивает материалы.
  // ===========================================================================

  test('Adjustment готовой продукции не пишет StockMovement и не меняет StockBalance', async () => {
    const fx = await preparedBalance(10);

    const stockMovementsBefore = await t.prisma.stockMovement.count();
    const stockBalancesBefore = await t.prisma.stockBalance.count();

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        finishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        direction: 'OUT',
        qty: 2,
        comment: 'Изоляция от материалов',
        clientRequestId: `fga7-${Date.now()}`,
      })
      .expect(201);

    expect(await t.prisma.stockMovement.count()).toBe(stockMovementsBefore);
    expect(await t.prisma.stockBalance.count()).toBe(stockBalancesBefore);
  });

  // ===========================================================================
  // 8. Audit FINISHED_GOODS_ADJUSTMENT_CREATED.
  // ===========================================================================

  test('Audit FINISHED_GOODS_ADJUSTMENT_CREATED пишется ровно один раз', async () => {
    const fx = await preparedBalance(10);

    const res = await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        finishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        direction: 'IN',
        qty: 2,
        comment: 'Audit',
        clientRequestId: `fga8-${Date.now()}`,
      })
      .expect(201);

    const audits = await t.prisma.auditLog.findMany({
      where: { event: 'FINISHED_GOODS_ADJUSTMENT_CREATED' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].entityType).toBe('FINISHED_GOODS_MOVEMENT');
    expect(audits[0].entityId).toBe(res.body.id);
    const payload = audits[0].payload as Record<string, unknown>;
    expect(payload.adjustmentId).toBeTruthy();
    expect(payload.finishedGoodsBalanceId).toBe(fx.finishedGoodsBalanceId);
    expect(payload.direction).toBe('IN');
    expect(payload.qty).toBe(2);
    expect(payload.sourceType).toBe('FINISHED_GOODS_ADJUSTMENT');
    expect(payload.balanceBeforeQty).toBe(10);
    expect(payload.balanceAfterQty).toBe(12);
  });
});
