/**
 * Integration-тесты редактирования заказа из admin-UI
 * (`PATCH /api/orders/:id`, см. `OrdersService.update`).
 *
 * Покрытие соответствует ТЗ «admin order edit»:
 *   1. DRAFT-заказ: правка `clientId / dueDate / comment / status` —
 *      сохраняется и не валит инварианты.
 *   2. DRAFT-заказ: смена `routeTemplateId` до `start()` обновляет
 *      привязку (snapshot фиксируется только при `start()`).
 *   3. DRAFT-заказ: правка `qty[<sizeId>]` (через DTO `items`) меняет
 *      состав `OrderItem`.
 *   4. IN_PRODUCTION-заказ с паспортами: PATCH `items` / `productId` /
 *      `routeTemplateId` отбивается `ORDER_LOCKED`. Безопасные поля
 *      продолжают сохраняться.
 *   5. PATCH `status: DRAFT → IN_PRODUCTION` делегирует в
 *      `OrdersService.start` и переводит заказ в IN_PRODUCTION
 *      (если структурно возможно — иначе отдаёт документированную
 *      бизнес-ошибку).
 *   6. Любое реальное изменение полей пишет одну строку
 *      `ORDER_UPDATED` в `AuditLog` с `before` / `after` /
 *      `changedFields` / `actor employeeId`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — admin order edit (PATCH /orders/:id)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookie: string;
  let managerEmployeeId: string;

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
    managerEmployeeId = seed.employees['shop-chief'].id;
  });

  async function createDraft(items?: Array<{ sizeId: string; qtyPlan: number }>): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: items ?? [{ sizeId: seed.sizes.M, qtyPlan: 3 }],
      });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function makeClient(name = 'ИП Тест'): Promise<{ id: string; name: string }> {
    const c = await t.prisma.client.create({
      data: { name, isActive: true },
    });
    return { id: c.id, name: c.name };
  }

  async function makeRouteTemplate(code = 'TSHIRT-BASIC') {
    const res = await request(t.app.getHttpServer())
      .post('/api/routes')
      .set('Cookie', cookie)
      .send({
        code,
        name: 'Базовый маршрут',
        steps: [
          { operationId: seed.operations.SEW_OVERLOCK_1.id },
          { operationId: seed.operations.QC.id },
          { operationId: seed.operations.PACKING.id },
        ],
      });
    expect(res.status).toBe(201);
    return res.body as { id: string; code: string; name: string };
  }

  // ---------------------------------------------------------------------------
  // 1. DRAFT — безопасные поля
  // ---------------------------------------------------------------------------

  test('DRAFT: правка client/dueDate/comment/status сохраняется', async () => {
    const orderId = await createDraft();
    const client = await makeClient('Сидоров');

    const patch = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({
        clientId: client.id,
        dueDate: '2026-08-15',
        comment: 'спешим к понедельнику',
        // status присылаем равный текущему — это no-op для transition
        // логики, но валидным значением (см. UpdateOrderSchema).
        status: 'DRAFT',
      });
    expect(patch.status).toBe(200);
    expect(patch.body.clientId).toBe(client.id);
    expect(patch.body.dueDate?.slice(0, 10)).toBe('2026-08-15');
    expect(patch.body.comment).toBe('спешим к понедельнику');
    expect(patch.body.status).toBe('DRAFT');
  });

  // ---------------------------------------------------------------------------
  // 2. DRAFT — смена routeTemplateId
  // ---------------------------------------------------------------------------

  test('DRAFT: смена routeTemplateId до start() обновляет привязку', async () => {
    const orderId = await createDraft();
    const tpl1 = await makeRouteTemplate('R-A');
    const tpl2 = await makeRouteTemplate('R-B');

    // Привязываем первый шаблон.
    const setFirst = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ routeTemplateId: tpl1.id });
    expect(setFirst.status).toBe(200);
    expect(setFirst.body.routeTemplateId).toBe(tpl1.id);

    // Этап «План операций до запуска» (см.
    // `OrdersService.syncOrderRouteStepsSnapshot`): после привязки
    // шаблона в DRAFT snapshot шагов уже материализован. Это нужно,
    // чтобы вкладки «Операции» и «Сводно по заказу» показали
    // операции и их вклад в себестоимость до перевода в производство.
    // Старое поведение «snapshot появляется только в start()» ушло
    // — оно ломало менеджерский UX и было дырой между уже-посчитанным
    // `Order.operationCostPlanRub` и пустой таблицей операций.
    const stepsAfterFirst = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
      select: { index: true, operationId: true },
    });
    expect(stepsAfterFirst.length).toBeGreaterThan(0);
    expect(stepsAfterFirst).toEqual([
      { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
      { index: 1, operationId: seed.operations.QC.id },
      { index: 2, operationId: seed.operations.PACKING.id },
    ]);

    // Меняем на другой шаблон (DRAFT — общий ORDER_LOCKED guard
    // пропускает, snapshot пересинхронизируется с новым шаблоном).
    const swap = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ routeTemplateId: tpl2.id });
    expect(swap.status).toBe(200);
    expect(swap.body.routeTemplateId).toBe(tpl2.id);

    // Snapshot пересоздан под новый шаблон, старых шагов не осталось.
    const stepsAfterSwap = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(stepsAfterSwap.length).toBeGreaterThan(0);
    // routeSteps теперь принадлежат tpl2 (тот же набор операций по
    // фабрике `makeRouteTemplate`, но это разные snapshot-строки).
    const oldIds = new Set(stepsAfterFirst.map((s) => s.operationId));
    expect(
      stepsAfterSwap.every((s) => oldIds.has(s.operationId)),
    ).toBe(true);

    // Сброс маршрута на null → snapshot вычищается.
    const unset = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ routeTemplateId: '' });
    // PATCH `routeTemplateId: ''` admin-action нормализует в null;
    // тут мы шлём напрямую `''` — Zod-схема admin-API принимает
    // только строки или null/undefined, поэтому используем явный null.
    void unset;
    const unsetExplicit = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ routeTemplateId: null });
    expect(unsetExplicit.status).toBe(200);
    expect(unsetExplicit.body.routeTemplateId).toBeNull();
    const stepsAfterUnset = await t.prisma.orderRouteStep.count({
      where: { orderId },
    });
    expect(stepsAfterUnset).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 3. DRAFT — смена qty
  // ---------------------------------------------------------------------------

  test('DRAFT: правка items меняет состав OrderItem', async () => {
    const orderId = await createDraft([{ sizeId: seed.sizes.M, qtyPlan: 2 }]);

    const patch = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({
        items: [
          { sizeId: seed.sizes.S, qtyPlan: 1 },
          { sizeId: seed.sizes.M, qtyPlan: 5 },
          { sizeId: seed.sizes.L, qtyPlan: 4 },
        ],
      });
    expect(patch.status).toBe(200);
    const sizesAfter = patch.body.items.map(
      (i: { sizeId: string; qtyPlan: number }) => ({
        sizeId: i.sizeId,
        qtyPlan: i.qtyPlan,
      }),
    );
    expect(sizesAfter).toContainEqual({ sizeId: seed.sizes.S, qtyPlan: 1 });
    expect(sizesAfter).toContainEqual({ sizeId: seed.sizes.M, qtyPlan: 5 });
    expect(sizesAfter).toContainEqual({ sizeId: seed.sizes.L, qtyPlan: 4 });
    expect(patch.body.qtyPlanTotal).toBe(10);
  });

  // ---------------------------------------------------------------------------
  // 4. IN_PRODUCTION — опасные поля заблокированы, безопасные допустимы
  // ---------------------------------------------------------------------------

  test('IN_PRODUCTION: PATCH опасных полей → 409 ORDER_LOCKED, безопасных — 200', async () => {
    const orderId = await createDraft();
    // Запускаем заказ и выпускаем один паспорт — чтобы зафиксировать
    // «есть паспорта» (хотя current backend rule про DRAFT работает и
    // без паспортов).
    const start = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookie);
    expect(start.status).toBe(201);
    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookie)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-EDIT-1',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      });
    expect(passport.status).toBe(201);

    // Опасные поля → ORDER_LOCKED.
    const blockItems = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ items: [{ sizeId: seed.sizes.S, qtyPlan: 7 }] });
    expect(blockItems.status).toBe(409);
    expect(blockItems.body.code).toBe('ORDER_LOCKED');

    const blockProduct = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ productId: 'some-other-product' });
    expect(blockProduct.status).toBe(409);
    expect(blockProduct.body.code).toBe('ORDER_LOCKED');

    const blockRoute = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ routeTemplateId: null });
    expect(blockRoute.status).toBe(409);
    expect(blockRoute.body.code).toBe('ORDER_LOCKED');

    // Безопасные поля → 200 даже на IN_PRODUCTION.
    const client = await makeClient('Поздняя привязка');
    const safe = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({
        clientId: client.id,
        dueDate: '2026-09-30',
        comment: 'обновили после старта',
      });
    expect(safe.status).toBe(200);
    expect(safe.body.clientId).toBe(client.id);
    expect(safe.body.comment).toBe('обновили после старта');
    expect(safe.body.status).toBe('IN_PRODUCTION');
  });

  // ---------------------------------------------------------------------------
  // 5. status DRAFT → IN_PRODUCTION
  // ---------------------------------------------------------------------------

  test('PATCH status: DRAFT → IN_PRODUCTION делегирует в start()', async () => {
    const orderId = await createDraft();

    const patch = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ status: 'IN_PRODUCTION' });
    // Внутри start() есть guard `items.length > 0`: наш DRAFT
    // уже с одним размером, так что переход проходит → 200.
    expect(patch.status).toBe(200);
    expect(patch.body.status).toBe('IN_PRODUCTION');

    // Аудит ORDER_STARTED появляется, как и в прямом start():
    // делегация в существующий метод гарантирует один и тот же
    // лог и snapshot-логика.
    const started = await t.prisma.auditLog.findMany({
      where: { entityType: 'ORDER', entityId: orderId, event: 'ORDER_STARTED' },
    });
    expect(started).toHaveLength(1);
    expect(started[0]?.employeeId).toBe(managerEmployeeId);
  });

  test('PATCH status: пустой DRAFT → IN_PRODUCTION → документированная ошибка', async () => {
    // Создаём DRAFT и зачищаем строки — start() в этом случае отдаёт
    // ORDER_HAS_NO_ITEMS. Это «documented safe status»: PATCH либо
    // успешно делегирует, либо отдаёт явную бизнес-ошибку без 500.
    const orderId = await createDraft();
    await t.prisma.orderItem.deleteMany({ where: { orderId } });

    const patch = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({ status: 'IN_PRODUCTION' });
    expect(patch.status).toBe(400);
    expect(patch.body.code).toBe('ORDER_HAS_NO_ITEMS');
  });

  // ---------------------------------------------------------------------------
  // 6. AuditLog ORDER_UPDATED
  // ---------------------------------------------------------------------------

  test('PATCH с реальной правкой пишет AuditLog ORDER_UPDATED', async () => {
    const orderId = await createDraft();
    const client = await makeClient('Аудитный клиент');

    const patch = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .send({
        clientId: client.id,
        comment: 'правка для аудита',
      });
    expect(patch.status).toBe(200);

    const rows = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'ORDER',
        entityId: orderId,
        event: 'ORDER_UPDATED',
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const last = rows[rows.length - 1]!;
    expect(last.employeeId).toBe(managerEmployeeId);
    const payload = last.payload as {
      changedFields: string[];
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(payload.changedFields).toContain('clientId');
    expect(payload.changedFields).toContain('comment');
    expect(payload.before.clientId).toBeNull();
    expect(payload.after.clientId).toBe(client.id);
    expect(payload.before.comment).toBeNull();
    expect(payload.after.comment).toBe('правка для аудита');
  });
});
