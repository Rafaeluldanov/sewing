/**
 * Integration-тесты привязки заказа к карточке клиента (`Order.clientId`)
 * и срока сдачи (`Order.dueDate`).
 *
 * Сценарии:
 *   1. POST /api/orders с `clientId` и `dueDate` сохраняет оба поля и
 *      возвращает их в `OrderDetailDto`.
 *   2. GET /api/orders (list) и GET /api/orders/:id отдают `client.{id,name}`
 *      и `dueDate` в ISO.
 *   3. PATCH /api/orders/:id меняет `clientId` и `dueDate`; `dueDate`
 *      можно снять (`null`), `clientId` — НЕТ (этап «Клиент —
 *      обязательный атрибут заказа», 400 `ORDER_CLIENT_REQUIRED`, см.
 *      `orders-client-required.test.ts`).
 *   4. clientId, указывающий на несуществующего клиента → 404 CLIENT_NOT_FOUND.
 *   5. clientId, указывающий на деактивированного клиента → 400 CLIENT_INACTIVE.
 *   6. ON DELETE SET NULL: удаление карточки клиента в БД оставляет
 *      заказ живым с `clientId = null` (заказ всегда переживает
 *      карточку клиента).
 *
 * См. `docs/api.md §«orders»`, `apps/api/src/modules/orders/orders.service.ts`,
 * `prisma/schema.prisma model Order`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — orders × client × dueDate', () => {
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

  async function makeClient(opts?: {
    name?: string;
    isActive?: boolean;
  }): Promise<{ id: string; name: string }> {
    const c = await t.prisma.client.create({
      data: {
        name: opts?.name ?? 'ИП Петров',
        isActive: opts?.isActive ?? true,
      },
    });
    return { id: c.id, name: c.name };
  }

  // ---------------------------------------------------------------------------
  // 1. CREATE
  // ---------------------------------------------------------------------------

  test('POST /api/orders сохраняет clientId + dueDate, ответ содержит их', async () => {
    const client = await makeClient();
    const due = '2026-12-31';

    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        clientId: client.id,
        dueDate: due,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.clientId).toBe(client.id);
    expect(res.body.client).toMatchObject({ id: client.id, name: client.name });
    // dueDate в ответе — ISO; начало строки соответствует переданной дате.
    expect(typeof res.body.dueDate).toBe('string');
    expect(res.body.dueDate.slice(0, 10)).toBe(due);

    // В БД действительно сохранилось.
    const inDb = await t.prisma.order.findUnique({ where: { id: res.body.id } });
    expect(inDb?.clientId).toBe(client.id);
    expect(inDb?.dueDate).not.toBeNull();
  });

  test('POST /api/orders без clientId/dueDate → null/undefined (backward-compatible)', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.S, qtyPlan: 1 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.clientId).toBeNull();
    expect(res.body.client).toBeNull();
    expect(res.body.dueDate).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 2. LIST + DETAIL
  // ---------------------------------------------------------------------------

  test('GET /api/orders (list) и /:id возвращают client + dueDate', async () => {
    const client = await makeClient({ name: 'List Client' });
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        clientId: client.id,
        dueDate: '2027-01-15',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 3 }],
      });
    expect(created.status).toBe(201);

    const list = await request(t.app.getHttpServer())
      .get('/api/orders')
      .set('Cookie', cookie);
    expect(list.status).toBe(200);
    const item = list.body.items.find(
      (o: { id: string }) => o.id === created.body.id,
    );
    expect(item).toBeDefined();
    expect(item.clientId).toBe(client.id);
    expect(item.client).toMatchObject({ id: client.id, name: client.name });
    expect(item.dueDate.slice(0, 10)).toBe('2027-01-15');

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${created.body.id}`)
      .set('Cookie', cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.client).toMatchObject({
      id: client.id,
      name: client.name,
    });
    expect(detail.body.dueDate.slice(0, 10)).toBe('2027-01-15');
  });

  // ---------------------------------------------------------------------------
  // 3. PATCH
  // ---------------------------------------------------------------------------

  test('PATCH /api/orders/:id меняет clientId и dueDate; dueDate=null сбрасывает, clientId=null — нет', async () => {
    const c1 = await makeClient({ name: 'Первый' });
    const c2 = await makeClient({ name: 'Второй' });

    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        clientId: c1.id,
        dueDate: '2026-06-01',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      });
    expect(created.status).toBe(201);

    const swap = await request(t.app.getHttpServer())
      .patch(`/api/orders/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ clientId: c2.id, dueDate: '2026-07-15' });
    expect(swap.status).toBe(200);
    expect(swap.body.clientId).toBe(c2.id);
    expect(swap.body.dueDate.slice(0, 10)).toBe('2026-07-15');

    // Этап «Клиент — обязательный атрибут заказа»: срок сдачи снять
    // можно, клиента — нельзя (400 `ORDER_CLIENT_REQUIRED`).
    const resetClient = await request(t.app.getHttpServer())
      .patch(`/api/orders/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ clientId: null });
    expect(resetClient.status).toBe(400);
    expect(resetClient.body.code).toBe('ORDER_CLIENT_REQUIRED');

    // Отказ атомарен: привязка осталась прежней.
    const afterFailedReset = await t.prisma.order.findUnique({
      where: { id: created.body.id },
    });
    expect(afterFailedReset?.clientId).toBe(c2.id);

    const resetDue = await request(t.app.getHttpServer())
      .patch(`/api/orders/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ dueDate: null });
    expect(resetDue.status).toBe(200);
    expect(resetDue.body.clientId).toBe(c2.id);
    expect(resetDue.body.dueDate).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 4. clientId не существует
  // ---------------------------------------------------------------------------

  test('clientId, указывающий на несуществующего клиента → 404 CLIENT_NOT_FOUND', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        clientId: 'no-such-client',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
  });

  // ---------------------------------------------------------------------------
  // 5. clientId деактивирован
  // ---------------------------------------------------------------------------

  test('clientId, указывающий на деактивированного клиента → 400 CLIENT_INACTIVE', async () => {
    const inactive = await makeClient({ name: 'Архивный', isActive: false });

    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        clientId: inactive.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLIENT_INACTIVE');
  });

  // ---------------------------------------------------------------------------
  // 6. ON DELETE SET NULL
  // ---------------------------------------------------------------------------

  test('удаление клиента в БД оставляет заказ с clientId=null (ON DELETE SET NULL)', async () => {
    const client = await makeClient({ name: 'Будет удалён' });
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        clientId: client.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      });
    expect(created.status).toBe(201);
    expect(created.body.clientId).toBe(client.id);

    // Удаляем напрямую в БД (HTTP-DELETE для клиентов нет; soft-only).
    await t.prisma.client.delete({ where: { id: client.id } });

    const stillThere = await t.prisma.order.findUnique({
      where: { id: created.body.id },
    });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.clientId).toBeNull();

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${created.body.id}`)
      .set('Cookie', cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.clientId).toBeNull();
    expect(detail.body.client).toBeNull();
  });
});
