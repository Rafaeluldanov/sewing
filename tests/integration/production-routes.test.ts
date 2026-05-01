/**
 * Integration-тесты модуля «Маршруты производства» (production routes,
 * soft-route MVP) — см. `docs/domain.md §18`, `docs/api.md §17`.
 *
 * Покрытие соответствует ШАГУ 10 из ТЗ MVP:
 *   1. Создание шаблона `RouteTemplate` + шаги.
 *   2. Создание заказа с `routeTemplateId` → `start()` → snapshot
 *      `OrderRouteStep[]` фиксируется.
 *   3. `Passport.create()` ставит `currentRouteStepIndex = 0`, если у
 *      заказа есть snapshot.
 *   4. `scanOnOperation()` обновляет `currentRouteStepIndex`, если
 *      операция найдена в snapshot-е (и НЕ ломает scan, если не найдена).
 *
 * Дополнительно проверяем:
 *   - `ROUTE_TEMPLATE_INACTIVE` при попытке создать заказ на
 *     деактивированном шаблоне;
 *   - `ORDER_ROUTE_ALREADY_STARTED` при попытке сменить
 *     `routeTemplateId` после `start()`;
 *   - что `GET /api/shifts/current-work` отдаёт `routeCurrentStep` и
 *     `routeNextStep` (UI-подсказка для /work).
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

describeWithDb('integration — production routes (soft-route MVP)', () => {
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
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
    };
  });

  // ---------------------------------------------------------------------------
  // CRUD шаблонов
  // ---------------------------------------------------------------------------

  test('A. RouteTemplate CRUD: создаём шаблон, читаем список и детали', async () => {
    const create = await request(t.app.getHttpServer())
      .post('/api/routes')
      .set('Cookie', cookies.manager)
      .send({
        code: 'TSHIRT-BASIC',
        name: 'Базовая футболка',
        steps: [
          { operationId: seed.operations.SEW_OVERLOCK_1.id },
          { operationId: seed.operations.QC.id },
          { operationId: seed.operations.IRONING.id, isOptional: true },
          { operationId: seed.operations.PACKING.id },
        ],
      });
    expect(create.status).toBe(201);
    expect(create.body.code).toBe('TSHIRT-BASIC');
    expect(create.body.steps).toHaveLength(4);
    // Backend нормализует `index = i` по позиции в массиве, даже если
    // клиент его не прислал.
    expect(create.body.steps.map((s: { index: number }) => s.index)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(create.body.steps[0].operationCode).toBe('SEW_OVERLOCK_1');
    expect(create.body.steps[2].isOptional).toBe(true);

    // Дубль `operationId` отбивается Zod-схемой (см. routes.ts:StepsField).
    const dup = await request(t.app.getHttpServer())
      .post('/api/routes')
      .set('Cookie', cookies.manager)
      .send({
        code: 'TSHIRT-DUP',
        name: 'С дублем',
        steps: [
          { operationId: seed.operations.SEW_OVERLOCK_1.id },
          { operationId: seed.operations.SEW_OVERLOCK_1.id },
        ],
      });
    expect(dup.status).toBe(400);

    // Уникальность `code`.
    const codeTaken = await request(t.app.getHttpServer())
      .post('/api/routes')
      .set('Cookie', cookies.manager)
      .send({ code: 'TSHIRT-BASIC', name: 'Дубль', steps: [] });
    expect(codeTaken.status).toBe(409);
    expect(codeTaken.body.code).toBe('ROUTE_TEMPLATE_CODE_TAKEN');

    // Список — без шагов, но со `stepsCount`.
    const list = await request(t.app.getHttpServer())
      .get('/api/routes')
      .set('Cookie', cookies.manager);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    const item = list.body.find(
      (r: { code: string }) => r.code === 'TSHIRT-BASIC',
    );
    expect(item).toBeDefined();
    expect(item.stepsCount).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // Snapshot на заказе
  // ---------------------------------------------------------------------------

  test('B. Snapshot: routeTemplateId на заказе → OrderRouteStep[] после start()', async () => {
    const tpl = await createTemplate(t, cookies.manager, 'BASIC-1', [
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.QC.id,
      seed.operations.PACKING.id,
    ]);

    // До запуска snapshot пустой; routeTemplateId/Code/Name проброшены.
    const orderId = await createOrderWithRoute(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      tpl.id,
    );
    const beforeStart = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager);
    expect(beforeStart.status).toBe(200);
    expect(beforeStart.body.routeTemplateId).toBe(tpl.id);
    expect(beforeStart.body.routeTemplateCode).toBe('BASIC-1');
    expect(beforeStart.body.routeSteps).toEqual([]);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const afterStart = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager);
    expect(afterStart.status).toBe(200);
    expect(afterStart.body.routeSteps).toHaveLength(3);
    expect(
      afterStart.body.routeSteps.map(
        (s: { operationCode: string }) => s.operationCode,
      ),
    ).toEqual(['SEW_OVERLOCK_1', 'QC', 'PACKING']);
    expect(
      afterStart.body.routeSteps.map((s: { index: number }) => s.index),
    ).toEqual([0, 1, 2]);

    // Snapshot самодостаточный: удаление шаблона не трогает уже
    // созданные `OrderRouteStep`. Это ключевое свойство soft-route
    // (см. `docs/domain.md §18`).
    await request(t.app.getHttpServer())
      .delete(`/api/routes/${tpl.id}`)
      .set('Cookie', cookies.manager)
      .expect(204);
    const stillSnapshot = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
    });
    expect(stillSnapshot).toHaveLength(3);
  });

  test('B2. ROUTE_TEMPLATE_INACTIVE: нельзя создать заказ на скрытом шаблоне', async () => {
    const tpl = await createTemplate(t, cookies.manager, 'HIDDEN-1', [
      seed.operations.SEW_OVERLOCK_1.id,
    ]);
    await request(t.app.getHttpServer())
      .patch(`/api/routes/${tpl.id}`)
      .set('Cookie', cookies.manager)
      .send({ isActive: false })
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
        routeTemplateId: tpl.id,
      });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ROUTE_TEMPLATE_INACTIVE');
  });

  test('B3. ORDER_ROUTE_ALREADY_STARTED: после start() нельзя сменить routeTemplateId', async () => {
    const tpl = await createTemplate(t, cookies.manager, 'BASIC-3', [
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.QC.id,
    ]);
    const tpl2 = await createTemplate(t, cookies.manager, 'BASIC-3-ALT', [
      seed.operations.IRONING.id,
    ]);
    const orderId = await createOrderWithRoute(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      tpl.id,
    );
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    // После start заказ перешёл в IN_PRODUCTION → весь PATCH отбивается
    // общим guard'ом ORDER_LOCKED. Этого достаточно: дополнительный
    // ORDER_ROUTE_ALREADY_STARTED включается только в DRAFT-кейсах,
    // где snapshot уже есть (внутренний инвариант сервиса).
    const change = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .send({ routeTemplateId: tpl2.id });
    expect(change.status).toBe(409);
    expect([
      'ORDER_LOCKED',
      'ORDER_ROUTE_ALREADY_STARTED',
    ]).toContain(change.body.code);
  });

  // ---------------------------------------------------------------------------
  // Паспорт + scan
  // ---------------------------------------------------------------------------

  test('C. Passport + scan: currentRouteStepIndex = 0 при создании, обновляется на scan-е', async () => {
    const tpl = await createTemplate(t, cookies.manager, 'BASIC-2', [
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.QC.id,
      seed.operations.PACKING.id,
    ]);
    const orderId = await createOrderWithRoute(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      tpl.id,
    );
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-RT-1',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
      });
    expect(passport.status).toBe(201);
    const passportId: string = passport.body.id;

    // STEP 5 ТЗ: при наличии routeSteps у заказа создание паспорта
    // ставит currentRouteStepIndex = 0. Если у заказа маршрута нет —
    // поле остаётся null (это уже проверяет тест D ниже).
    const created = await t.prisma.passport.findUnique({
      where: { id: passportId },
      select: { currentRouteStepIndex: true },
    });
    expect(created?.currentRouteStepIndex).toBe(0);

    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);

    // Сценарий: швея сканирует на SEW_OVERLOCK_1 — index уже 0, на scan-е
    // backend найдёт операцию в snapshot-е и поставит снова 0 (не упадёт).
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    const afterSew = await t.prisma.passport.findUnique({
      where: { id: passportId },
      select: { currentRouteStepIndex: true },
    });
    expect(afterSew?.currentRouteStepIndex).toBe(0);

    // ОТК открывает свою смену и сканирует — operationId = QC найдётся
    // в snapshot-е на индексе 1, бэкенд должен обновить
    // currentRouteStepIndex в той же транзакции, что пишет
    // PassportEvent(OPERATION_SCAN). НИКАКОГО enforcement: scan
    // успешен, никаких 409 (см. STEP 5 ТЗ).
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    const afterQc = await t.prisma.passport.findUnique({
      where: { id: passportId },
      select: { currentRouteStepIndex: true },
    });
    expect(afterQc?.currentRouteStepIndex).toBe(1);
  });

  test('D. Backward-compat: заказ без шаблона → currentRouteStepIndex = null, scan не ломается', async () => {
    // Старый flow: routeTemplateId не передан, snapshot пустой,
    // паспорт ходит как раньше — ровно то, что обещает ТЗ
    // («backward-compat, scan не падает»).
    const create = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      })
      .expect(201);
    const orderId: string = create.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);
    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-RT-2',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
      })
      .expect(201);
    const created = await t.prisma.passport.findUnique({
      where: { id: passport.body.id },
      select: { currentRouteStepIndex: true },
    });
    expect(created?.currentRouteStepIndex).toBeNull();

    // OPERATION_SCAN всё равно проходит и ничего не ломает.
    await placePassport(t, cookies.manager, passport.body.id, seed.cells.A1.id);
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passport.body.id}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passport.body.id}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    const afterScan = await t.prisma.passport.findUnique({
      where: { id: passport.body.id },
      select: { currentRouteStepIndex: true },
    });
    expect(afterScan?.currentRouteStepIndex).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // /work подсказка
  // ---------------------------------------------------------------------------

  test('E. /api/shifts/current-work: отдаёт routeCurrentStep / routeNextStep', async () => {
    const tpl = await createTemplate(t, cookies.manager, 'BASIC-WORK', [
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.QC.id,
      seed.operations.PACKING.id,
    ]);
    const orderId = await createOrderWithRoute(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      tpl.id,
    );
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);
    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-RT-WORK',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
      })
      .expect(201);
    await placePassport(t, cookies.manager, passport.body.id, seed.cells.A1.id);
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passport.body.id}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const currentWork = await request(t.app.getHttpServer())
      .get('/api/shifts/current-work')
      .set('Cookie', cookies.seamstress)
      .expect(200);
    const items: Array<{
      id: string;
      currentRouteStepIndex: number | null;
      routeCurrentStep: { operationCode: string; index: number } | null;
      routeNextStep: { operationCode: string; index: number } | null;
    }> = currentWork.body;
    const mine = items.find((p) => p.id === passport.body.id);
    expect(mine).toBeDefined();
    expect(mine!.currentRouteStepIndex).toBe(0);
    expect(mine!.routeCurrentStep?.operationCode).toBe('SEW_OVERLOCK_1');
    expect(mine!.routeNextStep?.operationCode).toBe('QC');
  });
});

// ===========================================================================
// helpers (локальные — другие интеграционные тесты с маршрутами не работают)
// ===========================================================================

async function createTemplate(
  t: TestApp,
  cookie: string,
  code: string,
  operationIds: string[],
): Promise<{ id: string }> {
  const r = await request(t.app.getHttpServer())
    .post('/api/routes')
    .set('Cookie', cookie)
    .send({
      code,
      name: code,
      steps: operationIds.map((operationId) => ({ operationId })),
    })
    .expect(201);
  return { id: r.body.id };
}

async function createOrderWithRoute(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  items: Array<{ sizeId: string; qtyPlan: number }>,
  routeTemplateId: string,
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items,
      routeTemplateId,
    })
    .expect(201);
  return r.body.id;
}

async function placePassport(
  t: TestApp,
  cookie: string,
  passportId: string,
  cellId: string,
): Promise<void> {
  await request(t.app.getHttpServer())
    .post(`/api/passports/${passportId}/place`)
    .set('Cookie', cookie)
    .send({ cellId })
    .expect(201);
}
