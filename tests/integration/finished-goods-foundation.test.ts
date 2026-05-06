/**
 * Integration-тест foundation готовой продукции.
 *
 * Покрываем:
 *   - happy-path: упаковка паспорта в коробку создаёт ровно одну запись
 *     `FinishedGoodsMovement` `type=PRODUCTION_RECEIPT`/`direction=IN`
 *     и увеличивает `FinishedGoodsBalance.qty` на `passport.qtyGood`;
 *   - movement привязан к `passportId` и `boxId`;
 *   - `warehouseId` берётся из `Order.finishedGoodsWarehouseId`;
 *   - если у заказа нет finishedGoodsWarehouseId — баланс «no-warehouse»
 *     (`warehouseId = null`), упаковка не блокируется;
 *   - идемпотентность: повторное `recordPackedPassportInTx` для уже
 *     упакованного паспорта не задвоит movement и не удвоит баланс;
 *   - audit `FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED` пишется в той
 *     же транзакции;
 *   - read-only API `/api/finished-goods/balances` и `/movements`
 *     отдаёт корректные данные и НЕ возвращает `sourceKey`.
 *
 * Стиль: следуем паттерну `packing-add-validation.test.ts` —
 * passport-ы создаются напрямую через `t.prisma.passport.create`,
 * через HTTP идём только сам `POST /api/packing/boxes/:id/add-passport`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { FinishedGoodsService } from '@sewing/api/modules/finished-goods/finished-goods.service';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — Finished goods foundation', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let orderId: string;
  let warehouseId: string;
  let finishedGoods: FinishedGoodsService;

  beforeAll(async () => {
    t = await startTestApp();
    finishedGoods = t.app.get(FinishedGoodsService);
  });
  afterAll(async () => {
    await stopTestApp(t);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookies = {
      packer: loginAs(t, seed.employees['packer']),
      manager: loginAs(t, seed.employees['shop-chief']),
    };

    // У упаковщика должна быть активная PACKING-смена.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.packer)
      .send({
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
      })
      .expect(201);

    // Создаём склад готовой продукции.
    const warehouse = await t.prisma.warehouse.create({
      data: {
        name: `Склад ГП ${Math.random().toString(36).slice(2, 8)}`,
        code: `FG-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        isActive: true,
      },
    });
    warehouseId = warehouse.id;

    const order = await t.prisma.order.create({
      data: {
        number: `O-FG-${Math.random().toString(36).slice(2, 8)}`,
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
  // Helpers
  // ---------------------------------------------------------------------------

  async function makePassport(args: {
    qtyGood?: number;
    productId?: string;
    sizeId?: string;
    color?: string;
    orderId?: string;
  } = {}): Promise<string> {
    const random = Math.random().toString(36).slice(2, 8);
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-FG-${random}`,
        qrCode: `passport:fg-${random}`,
        orderId: args.orderId ?? orderId,
        productId: args.productId ?? seed.product.id,
        sizeId: args.sizeId ?? seed.sizes.M,
        color: args.color ?? seed.product.color,
        rollNumber: `R-${random}`,
        cutDate: new Date(),
        qtyPlan: args.qtyGood ?? 3,
        qtyCut: args.qtyGood ?? 3,
        qtyGood: args.qtyGood ?? 3,
        status: 'IN_PROGRESS',
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
    return passport.id;
  }

  async function createBox(maxQty = 50): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/packing/boxes')
      .set('Cookie', cookies.packer)
      .send({ maxQty })
      .expect(201);
    return res.body.id as string;
  }

  function addPassport(boxId: string, passportId: string) {
    return request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/add-passport`)
      .set('Cookie', cookies.packer)
      .send({ passportId });
  }

  // ---------------------------------------------------------------------------
  // 1. Happy path: упаковка → PRODUCTION_RECEIPT IN, баланс растёт.
  // ---------------------------------------------------------------------------

  test('упаковка создаёт ровно одну запись PRODUCTION_RECEIPT IN и увеличивает баланс', async () => {
    const passportId = await makePassport({ qtyGood: 5 });
    const boxId = await createBox();

    const res = await addPassport(boxId, passportId);
    expect(res.status).toBe(201);

    const movements = await t.prisma.finishedGoodsMovement.findMany({
      where: { passportId },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe('PRODUCTION_RECEIPT');
    expect(movements[0].direction).toBe('IN');
    expect(movements[0].qty).toBe(5);
    expect(movements[0].orderId).toBe(orderId);
    expect(movements[0].productId).toBe(seed.product.id);
    expect(movements[0].sizeId).toBe(seed.sizes.M);
    expect(movements[0].color).toBe(seed.product.color);
    expect(movements[0].warehouseId).toBe(warehouseId);
    expect(movements[0].cellId).toBeNull();
    expect(movements[0].passportId).toBe(passportId);
    expect(movements[0].boxId).toBe(boxId);
    expect(movements[0].balanceBeforeQty).toBe(0);
    expect(movements[0].balanceAfterQty).toBe(5);

    const balance = await t.prisma.finishedGoodsBalance.findFirstOrThrow({
      where: { orderId, productId: seed.product.id, sizeId: seed.sizes.M },
    });
    expect(balance.qty).toBe(5);
    expect(balance.warehouseId).toBe(warehouseId);
    expect(balance.lastMovementAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 2. Order.finishedGoodsWarehouseId отсутствует — no-warehouse balance.
  // ---------------------------------------------------------------------------

  test('заказ без finishedGoodsWarehouseId → no-warehouse balance, упаковка не блокируется', async () => {
    const orderNoWh = await t.prisma.order.create({
      data: {
        number: `O-FG-NOWH-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        finishedGoodsWarehouseId: null,
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M,
            qtyPlan: 10,
          },
        },
      },
    });
    const passportId = await makePassport({
      qtyGood: 2,
      orderId: orderNoWh.id,
    });
    const boxId = await createBox();

    const res = await addPassport(boxId, passportId);
    expect(res.status).toBe(201);

    const movements = await t.prisma.finishedGoodsMovement.findMany({
      where: { passportId },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].warehouseId).toBeNull();

    const balance = await t.prisma.finishedGoodsBalance.findFirstOrThrow({
      where: { orderId: orderNoWh.id },
    });
    expect(balance.warehouseId).toBeNull();
    expect(balance.qty).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // 3. Идемпотентность: повторный recordPackedPassportInTx не задваивает.
  // ---------------------------------------------------------------------------

  test('идемпотентность: повторный recordPackedPassportInTx не задваивает движение', async () => {
    const passportId = await makePassport({ qtyGood: 4 });
    const boxId = await createBox();

    await addPassport(boxId, passportId).expect(201);

    // Берём сервис напрямую и вызываем повторно (имитация retry / replay).
    await t.prisma.$transaction(async (tx) => {
      await finishedGoods.recordPackedPassportInTx(
        tx,
        passportId,
        seed.employees.packer.id,
      );
    });

    const movements = await t.prisma.finishedGoodsMovement.findMany({
      where: { passportId },
    });
    expect(movements).toHaveLength(1);

    const balance = await t.prisma.finishedGoodsBalance.findFirstOrThrow({
      where: { orderId, productId: seed.product.id, sizeId: seed.sizes.M },
    });
    expect(balance.qty).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // 4. Audit FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED.
  // ---------------------------------------------------------------------------

  test('audit FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED пишется ровно один раз', async () => {
    const passportId = await makePassport({ qtyGood: 2 });
    const boxId = await createBox();

    await addPassport(boxId, passportId).expect(201);

    const audits = await t.prisma.auditLog.findMany({
      where: { event: 'FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].entityType).toBe('FINISHED_GOODS_MOVEMENT');
    const payload = audits[0].payload as Record<string, unknown>;
    expect(payload.orderId).toBe(orderId);
    expect(payload.passportId).toBe(passportId);
    expect(payload.boxId).toBe(boxId);
    expect(payload.qty).toBe(2);
    expect(payload.balanceBeforeQty).toBe(0);
    expect(payload.balanceAfterQty).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // 5. Read-only API.
  // ---------------------------------------------------------------------------

  test('GET /api/finished-goods/balances возвращает баланс без sourceKey', async () => {
    const passportId = await makePassport({ qtyGood: 7 });
    const boxId = await createBox();
    await addPassport(boxId, passportId).expect(201);

    const res = await request(t.app.getHttpServer())
      .get('/api/finished-goods/balances')
      .query({ orderId })
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.orderId).toBe(orderId);
    expect(item.productId).toBe(seed.product.id);
    expect(item.qty).toBe(7);
    expect(item.warehouseId).toBe(warehouseId);
    expect(item.sourceKey).toBeUndefined();
    expect(res.body.total).toBe(1);
  });

  test('GET /api/finished-goods/movements возвращает движения без sourceKey', async () => {
    const passportId = await makePassport({ qtyGood: 3 });
    const boxId = await createBox();
    await addPassport(boxId, passportId).expect(201);

    const res = await request(t.app.getHttpServer())
      .get('/api/finished-goods/movements')
      .query({ orderId, type: 'PRODUCTION_RECEIPT' })
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.type).toBe('PRODUCTION_RECEIPT');
    expect(item.direction).toBe('IN');
    expect(item.qty).toBe(3);
    expect(item.passportId).toBe(passportId);
    expect(item.boxId).toBe(boxId);
    expect(item.sourceKey).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 6. Material flows не затронуты.
  // ---------------------------------------------------------------------------

  test('упаковка не пишет StockMovement и не меняет StockBalance', async () => {
    const stockMovementsBefore = await t.prisma.stockMovement.count();
    const stockBalancesBefore = await t.prisma.stockBalance.count();

    const passportId = await makePassport({ qtyGood: 1 });
    const boxId = await createBox();
    await addPassport(boxId, passportId).expect(201);

    const stockMovementsAfter = await t.prisma.stockMovement.count();
    const stockBalancesAfter = await t.prisma.stockBalance.count();
    expect(stockMovementsAfter).toBe(stockMovementsBefore);
    expect(stockBalancesAfter).toBe(stockBalancesBefore);
  });
});
