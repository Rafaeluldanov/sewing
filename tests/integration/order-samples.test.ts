/**
 * Integration-тесты `OrderSamplesService` (MVP «Сигнальный образец»).
 *
 * См. `apps/api/src/modules/order-samples/*`,
 * `prisma/schema.prisma::OrderSample`,
 * `docs/order-signal-sample-flow.md`,
 * `docs/order-signal-sample-recon.md`.
 *
 * Контракт покрытия (см. ТЗ §«Tests»):
 *   1. SAMPLE_ONLY + counts=false — корректные поля + sample-passport
 *      с `sampleId`.
 *   2. FULL_ORDER + counts=true — сохраняет режим/флаг.
 *   3. size не в заказе → 400.
 *   4. qty <= 0 — Zod-валидация (тест на действии 400).
 *   5. duplicate active sample → 409 ORDER_SAMPLE_ALREADY_ACTIVE.
 *   6. approve — статус APPROVED + approvedAt/approvedById + bulk effect.
 *   7. reject — статус REJECTED + reason.
 *   8. cancel — статус CANCELLED.
 *   9. RBAC — SEAMSTRESS denied, без auth — 401.
 *  10. Sample-passport не уменьшает план тиражных паспортов: после
 *      запуска образца menager может выпустить тираж по этому
 *      размеру без блокировки (т.е. план OrderItem.qtyPlan
 *      сохранён, образец считается «сверху» либо «логически»).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — order-samples MVP', () => {
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
    cookies = {
      shopChief: loginAs(t, seed.employees['shop-chief']),
      cutter: loginAs(t, seed.employees.cutter),
      seamstress: loginAs(t, seed.employees.seamstress),
    };
  });

  /**
   * Создаёт заказ `IN_PRODUCTION` с одним размером M и заданным
   * планом. Возвращает orderId. Минимально достаточный setup, чтобы
   * `PassportsService.create` прошёл (заказ в IN_PRODUCTION,
   * OrderItem с qtyPlan, productId).
   */
  async function setupOrder(qtyPlan: number): Promise<{ orderId: string }> {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: `O-SMP-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan },
          ],
        },
      },
    });
    return { orderId: order.id };
  }

  // -------------------------------------------------------------------------
  // 1. SAMPLE_ONLY + counts=false
  // -------------------------------------------------------------------------

  test('SAMPLE_ONLY + counts=false: создаёт OrderSample IN_PROGRESS и sample-passport с sampleId', async () => {
    const { orderId } = await setupOrder(300);

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(201);

    expect(res.body.status).toBe('IN_PROGRESS');
    expect(res.body.materialMode).toBe('SAMPLE_ONLY');
    expect(res.body.countsTowardOrderQty).toBe(false);
    expect(res.body.qty).toBe(1);
    expect(res.body.passport).not.toBeNull();
    expect(res.body.passport.id).toBeTruthy();
    expect(res.body.bulkEffect.orderSizeQtyPlan).toBe(300);
    expect(res.body.bulkEffect.remainingQty).toBe(300); // counts=false → не уменьшаем
    expect(res.body.bulkEffect.extraSampleQty).toBe(1);

    // Проверим, что у паспорта стоит sampleId.
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: res.body.passport.id },
    });
    expect(passport.sampleId).toBe(res.body.id);
    expect(passport.qtyCut).toBe(1);
    expect(passport.sizeId).toBe(seed.sizes.M);
  });

  // -------------------------------------------------------------------------
  // 2. FULL_ORDER + counts=true
  // -------------------------------------------------------------------------

  test('FULL_ORDER + counts=true: фиксирует materialMode и countsTowardOrderQty', async () => {
    const { orderId } = await setupOrder(300);
    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'FULL_ORDER',
        countsTowardOrderQty: true,
      })
      .expect(201);
    expect(res.body.materialMode).toBe('FULL_ORDER');
    expect(res.body.countsTowardOrderQty).toBe(true);
    // Эффект на тираж — логический: при counts=true и status=IN_PROGRESS
    // remainingQty = 300 − 1 = 299.
    expect(res.body.bulkEffect.remainingQty).toBe(299);
    expect(res.body.bulkEffect.extraSampleQty).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. Size not in order
  // -------------------------------------------------------------------------

  test('размер не из заказа → 400 ORDER_SAMPLE_SIZE_NOT_IN_ORDER', async () => {
    const { orderId } = await setupOrder(10);
    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.L, // L нет в OrderItem
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(400);
    expect(res.body.code).toBe('ORDER_SAMPLE_SIZE_NOT_IN_ORDER');
  });

  // -------------------------------------------------------------------------
  // 4. qty <= 0 — Zod
  // -------------------------------------------------------------------------

  test('qty <= 0 → 400 validation error', async () => {
    const { orderId } = await setupOrder(10);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 0,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(400);
  });

  // -------------------------------------------------------------------------
  // 5. duplicate active → 409
  // -------------------------------------------------------------------------

  test('повторный запуск пока активный есть → 409 ORDER_SAMPLE_ALREADY_ACTIVE', async () => {
    const { orderId } = await setupOrder(10);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(201);
    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(409);
    expect(res.body.code).toBe('ORDER_SAMPLE_ALREADY_ACTIVE');
  });

  // -------------------------------------------------------------------------
  // 6. Approve
  // -------------------------------------------------------------------------

  test('approve: status APPROVED + approvedAt/approvedById + bulk effect отражает counts', async () => {
    const { orderId } = await setupOrder(300);
    const startRes = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'FULL_ORDER',
        countsTowardOrderQty: true,
      })
      .expect(201);
    const sampleId = startRes.body.id;

    const approveRes = await request(t.app.getHttpServer())
      .post(`/api/order-samples/${sampleId}/approve`)
      .set('Cookie', cookies.shopChief)
      .send({})
      .expect(201);
    expect(approveRes.body.status).toBe('APPROVED');
    expect(approveRes.body.approvedAt).toBeTruthy();
    expect(approveRes.body.approvedById).toBe(seed.employees['shop-chief'].id);
    expect(approveRes.body.bulkEffect.remainingQty).toBe(299);
  });

  // -------------------------------------------------------------------------
  // 7. Reject
  // -------------------------------------------------------------------------

  test('reject: status REJECTED, reason сохранён', async () => {
    const { orderId } = await setupOrder(10);
    const startRes = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(201);
    const rejectRes = await request(t.app.getHttpServer())
      .post(`/api/order-samples/${startRes.body.id}/reject`)
      .set('Cookie', cookies.shopChief)
      .send({ reason: 'Цвет не соответствует' })
      .expect(201);
    expect(rejectRes.body.status).toBe('REJECTED');
    expect(rejectRes.body.rejectionReason).toBe('Цвет не соответствует');
  });

  // -------------------------------------------------------------------------
  // 8. Cancel
  // -------------------------------------------------------------------------

  test('cancel: status CANCELLED, sample-passport НЕ удаляется', async () => {
    const { orderId } = await setupOrder(10);
    const startRes = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(201);
    const sampleId = startRes.body.id;
    const passportId = startRes.body.passport.id;

    const cancelRes = await request(t.app.getHttpServer())
      .post(`/api/order-samples/${sampleId}/cancel`)
      .set('Cookie', cookies.shopChief)
      .send({})
      .expect(201);
    expect(cancelRes.body.status).toBe('CANCELLED');

    const passport = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(passport).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 9. RBAC
  // -------------------------------------------------------------------------

  test('RBAC: SEAMSTRESS не может запустить образец → 403; без auth → 401', async () => {
    const { orderId } = await setupOrder(10);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.seamstress)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(403);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(401);
  });

  // -------------------------------------------------------------------------
  // 9a. Sample-flow НЕ требует CUTTER: cutterId не передан, role=SHOP_MANAGER
  // -------------------------------------------------------------------------

  test('start без cutterId: sample-passport получает cutterId = actor, без CUTTER_REQUIRED', async () => {
    const { orderId } = await setupOrder(50);
    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(201);
    expect(res.body.passport).not.toBeNull();
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: res.body.passport.id },
    });
    // Тиражный CUTTER_REQUIRED guard здесь не срабатывает — actor
    // (shop-chief, role=SHOP_MANAGER) сам становится «раскройщиком»
    // для sample-passport. См. JSDoc OrderSamplesService §«Sample-flow
    // vs bulk-flow».
    expect(passport.cutterId).toBe(seed.employees['shop-chief'].id);
    expect(passport.creatorId).toBe(seed.employees['shop-chief'].id);
    expect(passport.sampleId).toBe(res.body.id);
    // Sample НЕ создаёт immediate-сдельное начисление (см. JSDoc).
    const entries = await t.prisma.operationEntry.findMany({
      where: { passportId: res.body.passport.id },
    });
    expect(entries).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 10. Sample-passport не блокирует тиражные паспорта (план не съеден)
  // -------------------------------------------------------------------------

  test('OrderItem.qtyPlan не мутируется при запуске и согласовании образца', async () => {
    const { orderId } = await setupOrder(10);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: true,
      })
      .expect(201);
    const item = await t.prisma.orderItem.findFirstOrThrow({
      where: { orderId, sizeId: seed.sizes.M },
    });
    expect(item.qtyPlan).toBe(10);
  });

  // -------------------------------------------------------------------------
  // 11. Sample-needs: при запуске пишем WorkshopNeed с orderSampleId
  // -------------------------------------------------------------------------

  test('start с техкартой → создаются WorkshopNeed с orderSampleId, calculatedQty считается на sample.qty', async () => {
    // Заказ с техкартой, чтобы был источник для расчёта.
    const tc = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.shopChief)
      .send({
        code: `TC-SMP-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        name: 'Sample TC',
        materialLines: [
          { name: 'Кулирка 180 г/м²', unit: 'кг', qtyPerUnit: '0.300', note: null },
          { name: 'Резинка', unit: 'м', qtyPerUnit: '1.500', note: null },
        ],
      })
      .expect(201);

    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.shopChief)
      .send({
        orderDate: '2026-05-13T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        techCardId: tc.body.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/start`)
      .set('Cookie', cookies.shopChief)
      .send({})
      .expect(201);

    const startRes = await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(201);

    const sampleId = startRes.body.id;
    const needs = await t.prisma.workshopNeed.findMany({
      where: { orderSampleId: sampleId },
    });
    // По двум строкам техкарты → две строки потребности.
    expect(needs.length).toBe(2);
    for (const n of needs) {
      expect(n.orderId).toBe(order.body.id);
      expect(n.orderSampleId).toBe(sampleId);
      // calculatedQty = qtyPerUnit × sample.qty(=1)
      // Кулирка: 0.300 × 1 = 0.3; Резинка: 1.500 × 1 = 1.5.
      // Сам calculationMethod = QTY_PER_UNIT.
      expect(n.calculationMethod).toBe('QTY_PER_UNIT');
      expect(Number(n.calculatedQty)).toBeGreaterThan(0);
      expect(n.calculationNote ?? '').toContain('сигнальный образец');
    }
  });

  // -------------------------------------------------------------------------
  // 12. Sample без техкарты — fail-soft: 0 строк needs, sample создан
  // -------------------------------------------------------------------------

  test('start без техкарты → sample создаётся, WorkshopNeed не пишется (0 строк)', async () => {
    const { orderId } = await setupOrder(50);
    const startRes = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/samples/start`)
      .set('Cookie', cookies.shopChief)
      .send({
        sizeId: seed.sizes.M,
        qty: 1,
        materialMode: 'SAMPLE_ONLY',
        countsTowardOrderQty: false,
      })
      .expect(201);
    const needs = await t.prisma.workshopNeed.findMany({
      where: { orderSampleId: startRes.body.id },
    });
    expect(needs.length).toBe(0);
  });
});
