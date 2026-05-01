/**
 * Integration-тесты этапа «Номенклатура = Лекала»
 * (см. `docs/recon-soft-integration.md §«Номенклатура = Лекала»`,
 * `apps/api/src/modules/orders/orders.service.ts`,
 * `prisma/schema.prisma model PatternItem.legacyProductId`).
 *
 * Сценарии:
 *   1. POST /api/orders с `patternItemId` БЕЗ `productId` создаёт
 *      заказ. Backend через `OrdersService.ensureLegacyProductForPattern()`
 *      создаёт «технический» legacy Product, проставляет
 *      `PatternItem.legacyProductId` и пишет его id в
 *      `OrderItem.productId` (legacy-учёт остаётся живым без участия
 *      менеджера).
 *   2. Повторное создание заказа по тому же лекалу НЕ плодит второй
 *      Product — переиспользует существующий
 *      `PatternItem.legacyProductId` (инвариант «один лекало =
 *      один Product», обеспечен `@unique` + helper-ом).
 *   3. POST /api/orders без `patternItemId` и без `productId` отбивается
 *      Zod-валидацией с адресной ошибкой «Выберите номенклатуру / лекало»
 *      (`CreateOrderSchema.superRefine`).
 *   4. Старый flow «POST /api/orders с `productId` без `patternItemId`»
 *      продолжает работать (CUTTER_ASSISTANT, прямой POST) —
 *      создаётся заказ, никаких новых Product не плодим.
 *   5. PATCH /api/orders/:id меняет `patternItemId` на DRAFT-заказе:
 *      backend атомарно пересинхронизирует `OrderItem.productId` со
 *      скрытым legacy Product выбранного лекала.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — orders × pattern as product', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookie: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookie = loginAs(t, seed.employees['shop-chief']);
  });

  async function makePattern(opts?: {
    name?: string;
    article?: string;
    status?: string;
  }): Promise<{ id: string; name: string; article: string }> {
    const p = await t.prisma.patternItem.create({
      data: {
        name: opts?.name ?? 'Пижама детская',
        article: opts?.article ?? 'P-PIJAMA-1',
        status: opts?.status ?? 'ACTIVE',
      },
    });
    return { id: p.id, name: p.name, article: p.article };
  }

  // ---------------------------------------------------------------------------
  // 1. POST /api/orders по patternItemId без productId
  // ---------------------------------------------------------------------------

  test('POST без productId, только patternItemId: backend создаёт legacy Product и проставляет связи', async () => {
    const pattern = await makePattern();
    // До запроса по этому лекалу нет привязанного Product.
    const beforeProductsCount = await t.prisma.product.count();

    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        patternItemId: pattern.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.patternItemId).toBe(pattern.id);
    // В ответе видим имя legacy Product = имя лекала (его helper
    // подставил через `OrdersService.ensureLegacyProductForPattern()`).
    expect(res.body.productName).toBe(pattern.name);

    // PatternItem.legacyProductId заполнен, и Product действительно
    // существует, активен.
    const patternAfter = await t.prisma.patternItem.findUnique({
      where: { id: pattern.id },
      select: { legacyProductId: true },
    });
    expect(patternAfter?.legacyProductId).toBeTruthy();
    const legacy = await t.prisma.product.findUnique({
      where: { id: patternAfter!.legacyProductId! },
    });
    expect(legacy).not.toBeNull();
    expect(legacy?.active).toBe(true);
    expect(legacy?.name).toBe(pattern.name);

    // OrderItem.productId = legacy Product id — старый учёт продолжает
    // работать без участия менеджера.
    const items = await t.prisma.orderItem.findMany({
      where: { orderId: res.body.id },
    });
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.productId).toBe(patternAfter!.legacyProductId);
    }

    // Создан ровно один новый Product (legacy-технический), seed-ный
    // тестовый Product не тронут.
    const afterProductsCount = await t.prisma.product.count();
    expect(afterProductsCount).toBe(beforeProductsCount + 1);
  });

  // ---------------------------------------------------------------------------
  // 2. Повторное создание заказа по тому же лекалу не плодит Product
  // ---------------------------------------------------------------------------

  test('повторное создание заказа по тому же лекалу не плодит второй Product', async () => {
    const pattern = await makePattern({ article: 'P-REUSE-1' });

    const first = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        patternItemId: pattern.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      });
    expect(first.status).toBe(201);

    const second = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        patternItemId: pattern.id,
        items: [{ sizeId: seed.sizes.L, qtyPlan: 2 }],
      });
    expect(second.status).toBe(201);

    // У обоих заказов OrderItem.productId совпадает (тот же legacy
    // Product, помеченный на PatternItem.legacyProductId).
    const itemsFirst = await t.prisma.orderItem.findMany({
      where: { orderId: first.body.id },
    });
    const itemsSecond = await t.prisma.orderItem.findMany({
      where: { orderId: second.body.id },
    });
    expect(itemsFirst[0]?.productId).toBeTruthy();
    expect(itemsSecond[0]?.productId).toBe(itemsFirst[0]?.productId);

    // Всего Product-ов: seed-ный + один технический legacy.
    // Помечаем «вокруг этого лекала» через legacyProductId на самом
    // PatternItem, чтобы не зависеть от точного количества seed-ов.
    const linked = await t.prisma.product.findMany({
      where: { patternItems: { some: { id: pattern.id } } },
    });
    expect(linked).toHaveLength(1);
    expect(linked[0]?.id).toBe(itemsFirst[0]?.productId);
  });

  // ---------------------------------------------------------------------------
  // 3. POST без обоих полей → Zod-ошибка с адресным сообщением
  // ---------------------------------------------------------------------------

  test('POST без productId и без patternItemId возвращает 400 с адресной ошибкой', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      });
    expect(res.status).toBe(400);
    // Zod-сообщение из superRefine — менеджер сразу понимает, что
    // именно поле «номенклатура / лекало» обязательно.
    const message: string =
      typeof res.body?.message === 'string'
        ? res.body.message
        : Array.isArray(res.body?.message)
          ? res.body.message.join(' ')
          : JSON.stringify(res.body);
    expect(message).toMatch(/номенклатур|лекал/i);
  });

  // ---------------------------------------------------------------------------
  // 4. Backward-compat: старый flow с productId без patternItemId
  // ---------------------------------------------------------------------------

  test('legacy flow с productId без patternItemId продолжает работать', async () => {
    const beforeProductsCount = await t.prisma.product.count();
    const beforePatterns = await t.prisma.patternItem.count();

    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 3 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.productId).toBe(seed.product.id);
    expect(res.body.patternItemId).toBeNull();

    const items = await t.prisma.orderItem.findMany({
      where: { orderId: res.body.id },
    });
    expect(items[0]?.productId).toBe(seed.product.id);

    // Никаких новых Product / PatternItem не появилось — мы пошли по
    // старому flow, helper не вызывался.
    expect(await t.prisma.product.count()).toBe(beforeProductsCount);
    expect(await t.prisma.patternItem.count()).toBe(beforePatterns);
  });

  // ---------------------------------------------------------------------------
  // 5. PATCH patternItemId на DRAFT пересинхронизирует OrderItem.productId
  // ---------------------------------------------------------------------------

  test('PATCH patternItemId на DRAFT-заказе пересинхронизирует OrderItem.productId', async () => {
    const patternA = await makePattern({
      name: 'Лекало A',
      article: 'P-A-1',
    });
    const patternB = await makePattern({
      name: 'Лекало B',
      article: 'P-B-1',
    });

    // Создаём заказ по патерну A → backend подставит legacy Product A.
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        patternItemId: patternA.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      });
    expect(created.status).toBe(201);
    const orderId = created.body.id;
    const aLegacy = (await t.prisma.patternItem.findUnique({
      where: { id: patternA.id },
      select: { legacyProductId: true },
    }))?.legacyProductId;
    expect(aLegacy).toBeTruthy();
    const itemsBefore = await t.prisma.orderItem.findMany({
      where: { orderId },
    });
    expect(itemsBefore[0]?.productId).toBe(aLegacy);

    // Меняем лекало на B → backend через
    // `ensureLegacyProductForPattern(B)` создаёт legacy Product B и
    // обновляет `OrderItem.productId` сразу для всех строк заказа.
    const patched = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ patternItemId: patternB.id });
    expect(patched.status).toBe(200);
    expect(patched.body.patternItemId).toBe(patternB.id);

    const bLegacy = (await t.prisma.patternItem.findUnique({
      where: { id: patternB.id },
      select: { legacyProductId: true },
    }))?.legacyProductId;
    expect(bLegacy).toBeTruthy();
    expect(bLegacy).not.toBe(aLegacy);

    const itemsAfter = await t.prisma.orderItem.findMany({
      where: { orderId },
    });
    expect(itemsAfter.length).toBeGreaterThan(0);
    for (const it of itemsAfter) {
      expect(it.productId).toBe(bLegacy);
    }
  });
});
