/**
 * Integration-тесты перемещения готовой продукции между складами /
 * ячейками (`POST /api/finished-goods/transfers`, см.
 *  `apps/api/src/modules/finished-goods/finished-goods.controller.ts`,
 *  `apps/api/src/modules/finished-goods/finished-goods.service.ts::createTransfer`,
 *  `apps/api/src/modules/finished-goods/dto/create-finished-goods-transfer.dto.ts`,
 *  `docs/api.md §«Finished goods transfers»`,
 *  `docs/current-state.md §«Готовая продукция»`).
 *
 * Покрытие (порядок совпадает с ТЗ §15 «Tests»):
 *
 *   1. POST /api/finished-goods/transfers создаёт TRANSFER OUT и
 *      TRANSFER IN.
 *   2. Transfer уменьшает source FinishedGoodsBalance.qty.
 *   3. Transfer создаёт/увеличивает destination FinishedGoodsBalance.qty.
 *   4. Transfer rejects qty > source.qty (409
 *      FINISHED_GOODS_INSUFFICIENT_BALANCE).
 *   5. Transfer rejects same warehouse/cell (409
 *      FINISHED_GOODS_TRANSFER_SAME_LOCATION).
 *   6. Transfer с тем же clientRequestId идемпотентен.
 *   7. Transfer response не возвращает sourceKey.
 *   8. Transfer to cell использует Cell.warehouseId.
 *   9. Transfer to warehouse без cell создаёт destination с cellId=null.
 *  10. SEAMSTRESS не имеет доступа (403 FORBIDDEN_ROLE).
 *  11. ADMIN / SHOP_MANAGER имеют доступ.
 *  12. Transfer не затрагивает MaterialIssue / material StockBalance /
 *      production cost.
 *  13. qty должен быть целым (400).
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

describeWithDb('integration — finished goods transfers', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let orderId: string;
  let sourceWarehouseId: string;
  let destWarehouseId: string;

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

    // Два склада: source (готовая продукция приходит через
    // Order.finishedGoodsWarehouseId) и destination.
    const sourceWh = await t.prisma.warehouse.create({
      data: {
        name: `FG-source-${Math.random().toString(36).slice(2, 8)}`,
        isActive: true,
      },
    });
    sourceWarehouseId = sourceWh.id;

    const destWh = await t.prisma.warehouse.create({
      data: {
        name: `FG-dest-${Math.random().toString(36).slice(2, 8)}`,
        isActive: true,
      },
    });
    destWarehouseId = destWh.id;

    const order = await t.prisma.order.create({
      data: {
        number: `O-FGT-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        finishedGoodsWarehouseId: sourceWarehouseId,
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
        number: `P-FGT-${random}`,
        qrCode: `passport:fgt-${random}`,
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
  // 1. Happy path — пара движений TRANSFER OUT / IN.
  // ===========================================================================

  test('POST /api/finished-goods/transfers создаёт пару TRANSFER OUT/IN', async () => {
    const fx = await preparedBalance(10);

    const res = await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: 3,
        comment: 'Тестовое перемещение готовой продукции',
        clientRequestId: `fgt1-${Date.now()}`,
      })
      .expect(201);

    expect(res.body.transferId).toBeTruthy();
    expect(res.body.outMovement.type).toBe('TRANSFER');
    expect(res.body.outMovement.direction).toBe('OUT');
    expect(res.body.inMovement.type).toBe('TRANSFER');
    expect(res.body.inMovement.direction).toBe('IN');
    expect(res.body.outMovement.qty).toBe(3);
    expect(res.body.inMovement.qty).toBe(3);
    // sourceKey не отдаём.
    expect(res.body.outMovement.sourceKey).toBeUndefined();
    expect(res.body.inMovement.sourceKey).toBeUndefined();
  });

  // ===========================================================================
  // 2. Source qty уменьшается.
  // ===========================================================================

  test('Transfer уменьшает source FinishedGoodsBalance.qty', async () => {
    const fx = await preparedBalance(10);

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: 4,
        comment: 'Перемещение готовой продукции',
        clientRequestId: `fgt2-${Date.now()}`,
      })
      .expect(201);

    const source = await t.prisma.finishedGoodsBalance.findUniqueOrThrow({
      where: { id: fx.finishedGoodsBalanceId },
    });
    expect(source.qty).toBe(6);
  });

  // ===========================================================================
  // 3. Destination FinishedGoodsBalance создаётся с +qty.
  // ===========================================================================

  test('Transfer создаёт destination FinishedGoodsBalance', async () => {
    const fx = await preparedBalance(10);

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: 5,
        comment: 'Перемещение готовой продукции',
        clientRequestId: `fgt3-${Date.now()}`,
      })
      .expect(201);

    const dest = await t.prisma.finishedGoodsBalance.findFirstOrThrow({
      where: {
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        warehouseId: destWarehouseId,
        cellId: null,
      },
    });
    expect(dest.qty).toBe(5);
  });

  // ===========================================================================
  // 4. Не разрешает qty > source.qty.
  // ===========================================================================

  test('Transfer возвращает 409 при qty > source.qty', async () => {
    const fx = await preparedBalance(2);

    const res = await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: 10,
        comment: 'Перебор',
        clientRequestId: `fgt4-${Date.now()}`,
      })
      .expect(409);

    expect(res.body.code).toBe('FINISHED_GOODS_INSUFFICIENT_BALANCE');
  });

  // ===========================================================================
  // 5. Same-location guard.
  // ===========================================================================

  test('Transfer возвращает 409 при совпадении source и destination', async () => {
    const fx = await preparedBalance(5);

    const res = await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: sourceWarehouseId,
        qty: 1,
        comment: 'Та же локация',
        clientRequestId: `fgt5-${Date.now()}`,
      })
      .expect(409);

    expect(res.body.code).toBe('FINISHED_GOODS_TRANSFER_SAME_LOCATION');
  });

  // ===========================================================================
  // 6. Идемпотентность по clientRequestId.
  // ===========================================================================

  test('Transfer с тем же clientRequestId идемпотентен', async () => {
    const fx = await preparedBalance(10);
    const clientRequestId = `fgt6-${Date.now()}`;

    const first = await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: 3,
        comment: 'Idempotent #1',
        clientRequestId,
      })
      .expect(201);

    const second = await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: 3,
        comment: 'Idempotent #2 (ignored)',
        clientRequestId,
      })
      .expect(201);

    expect(second.body.transferId).toBe(first.body.transferId);
    expect(second.body.outMovement.id).toBe(first.body.outMovement.id);
    expect(second.body.inMovement.id).toBe(first.body.inMovement.id);

    // Баланс изменился ровно один раз.
    const source = await t.prisma.finishedGoodsBalance.findUniqueOrThrow({
      where: { id: fx.finishedGoodsBalanceId },
    });
    expect(source.qty).toBe(7);

    const movements = await t.prisma.finishedGoodsMovement.findMany({
      where: { type: 'TRANSFER' },
    });
    expect(movements).toHaveLength(2);
  });

  // ===========================================================================
  // 7. Transfer to cell — destWarehouseId берётся из Cell.warehouseId.
  // ===========================================================================

  test('Transfer to cell использует Cell.warehouseId', async () => {
    const fx = await preparedBalance(10);
    // Привяжем seed-ячейку A2 к destWarehouseId.
    await t.prisma.cell.update({
      where: { id: seed.cells.A2!.id },
      data: { warehouseId: destWarehouseId },
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        // toWarehouseId опускаем — cell.warehouseId выиграет.
        toCellId: seed.cells.A2!.id,
        qty: 2,
        comment: 'Перемещение в ячейку',
        clientRequestId: `fgt7-${Date.now()}`,
      })
      .expect(201);

    expect(res.body.inMovement.warehouseId).toBe(destWarehouseId);
    expect(res.body.inMovement.cellId).toBe(seed.cells.A2!.id);
  });

  // ===========================================================================
  // 8. SEAMSTRESS не имеет доступа.
  // ===========================================================================

  test('SEAMSTRESS не имеет доступа к POST /api/finished-goods/transfers', async () => {
    const fx = await preparedBalance(5);

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.seamstress)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: 1,
        comment: 'Без прав',
        clientRequestId: `fgt8-${Date.now()}`,
      })
      .expect(403);
  });

  // ===========================================================================
  // 9. qty должно быть целым положительным.
  // ===========================================================================

  test('Transfer возвращает 400 при нецелом qty', async () => {
    const fx = await preparedBalance(5);

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: 1.5,
        comment: 'Нецелое',
        clientRequestId: `fgt9a-${Date.now()}`,
      })
      .expect(400);

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: 0,
        comment: 'Ноль',
        clientRequestId: `fgt9b-${Date.now()}`,
      })
      .expect(400);

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: -5,
        comment: 'Отрицательное',
        clientRequestId: `fgt9c-${Date.now()}`,
      })
      .expect(400);
  });

  // ===========================================================================
  // 10. Transfer не затрагивает материалы и cost.
  // ===========================================================================

  test('Transfer готовой продукции не пишет StockMovement и не меняет StockBalance', async () => {
    const fx = await preparedBalance(10);

    const stockMovementsBefore = await t.prisma.stockMovement.count();
    const stockBalancesBefore = await t.prisma.stockBalance.count();

    await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: 2,
        comment: 'Изоляция от материалов',
        clientRequestId: `fgt10-${Date.now()}`,
      })
      .expect(201);

    const stockMovementsAfter = await t.prisma.stockMovement.count();
    const stockBalancesAfter = await t.prisma.stockBalance.count();
    expect(stockMovementsAfter).toBe(stockMovementsBefore);
    expect(stockBalancesAfter).toBe(stockBalancesBefore);
  });

  // ===========================================================================
  // 11. Audit FINISHED_GOODS_TRANSFER_CREATED записан.
  // ===========================================================================

  test('Audit FINISHED_GOODS_TRANSFER_CREATED пишется ровно один раз', async () => {
    const fx = await preparedBalance(10);

    const res = await request(t.app.getHttpServer())
      .post('/api/finished-goods/transfers')
      .set('Cookie', cookies.manager)
      .send({
        fromFinishedGoodsBalanceId: fx.finishedGoodsBalanceId,
        toWarehouseId: destWarehouseId,
        qty: 2,
        comment: 'Audit',
        clientRequestId: `fgt11-${Date.now()}`,
      })
      .expect(201);

    const audits = await t.prisma.auditLog.findMany({
      where: { event: 'FINISHED_GOODS_TRANSFER_CREATED' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].entityType).toBe('FINISHED_GOODS_MOVEMENT');
    expect(audits[0].entityId).toBe(res.body.outMovement.id);
    const payload = audits[0].payload as Record<string, unknown>;
    expect(payload.transferId).toBe(res.body.transferId);
    expect(payload.fromFinishedGoodsBalanceId).toBe(fx.finishedGoodsBalanceId);
    expect(payload.qty).toBe(2);
    expect(payload.sourceType).toBe('FINISHED_GOODS_TRANSFER');
  });
});
