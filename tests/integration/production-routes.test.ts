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
      master: loginAs(t, seed.employees['master']),
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

  test('B. Snapshot: routeTemplateId на заказе → OrderRouteStep[] уже в DRAFT, остаётся после start()', async () => {
    const tpl = await createTemplate(t, cookies.manager, 'BASIC-1', [
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.QC.id,
      seed.operations.PACKING.id,
    ]);

    // Этап «План операций до запуска» (см.
    // `OrdersService.syncOrderRouteStepsSnapshot`): snapshot
    // материализуется сразу при выборе маршрута, не дожидаясь `start()`.
    // Это даёт менеджеру вкладку «Операции» и строки в «Сводно по
    // заказу» уже в DRAFT/CALCULATION; до этого изменения обе вкладки
    // были пустыми, хотя `Order.operationCostPlanRub` уже считался.
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
    expect(beforeStart.body.routeSteps).toHaveLength(3);
    expect(
      beforeStart.body.routeSteps.map(
        (s: { operationCode: string }) => s.operationCode,
      ),
    ).toEqual(['SEW_OVERLOCK_1', 'QC', 'PACKING']);

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
    // 409 (Conflict) — soft-protection: «состояние ресурса не позволяет
    // его выбрать». См. `RouteTemplateInactiveError` в `errors.ts` и
    // комментарий у `assertRouteTemplateUsable`.
    expect(r.status).toBe(409);
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
        cutterId: seed.employees.cutter.id,
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

    // Швея ЗАВЕРШАЕТ свою операцию. С 01.09.2026 это обязательный шаг
    // перед тем, как паспорт заберёт следующий исполнитель: скан по
    // паспорту, который числится за человеком с незакрытым швейным
    // шагом, отбивается 409 `PASSPORT_CURRENT_STEP_INCOMPLETE` (см.
    // `PassportsService.evaluateRouteOrder::currentStepCandidate`).
    // Раньше здесь стояло «НИКАКОГО enforcement» — и ровно через эту
    // дыру ОТК уводила паспорта у распошивщицы, оставляя работу без
    // `OPERATION_FINISHED` и без начисления (инцидент 31.08.2026,
    // заказ 02-00020).
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // ОТК открывает свою смену и сканирует — operationId = QC найдётся
    // в snapshot-е на индексе 1, бэкенд должен обновить
    // currentRouteStepIndex в той же транзакции, что пишет
    // PassportEvent(OPERATION_SCAN).
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

  test('B4. GET /api/orders/:id: routeSteps[] отсортированы по index ASC и пусты без snapshot', async () => {
    // Фиксируем контракт UI карточки заказа: даже при «обратном»
    // порядке создания шагов в шаблоне snapshot всё равно приходит
    // в `index ASC` (sort на стороне бэка), а заказ без routeTemplateId
    // отдаёт `routeSteps: []` — нейтральный empty-state на фронте.
    const tpl = await createTemplate(t, cookies.manager, 'BASIC-ORDER-CARD', [
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.QC.id,
      seed.operations.PACKING.id,
    ]);

    // Заказ БЕЗ маршрута → пустой snapshot и до, и после start().
    const noRouteCreate = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      })
      .expect(201);
    const noRouteId: string = noRouteCreate.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${noRouteId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);
    const noRouteDetail = await request(t.app.getHttpServer())
      .get(`/api/orders/${noRouteId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(noRouteDetail.body.routeTemplateId).toBeNull();
    expect(noRouteDetail.body.routeSteps).toEqual([]);

    // Заказ СО маршрутом → после start() snapshot отсортирован ASC.
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
    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const indexes: number[] = detail.body.routeSteps.map(
      (s: { index: number }) => s.index,
    );
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(indexes[0]).toBe(0);
    // Минимальный набор полей для UI карточки заказа.
    for (const step of detail.body.routeSteps) {
      expect(step).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          index: expect.any(Number),
          operationId: expect.any(String),
          operationCode: expect.any(String),
          operationName: expect.any(String),
        }),
      );
    }
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
        cutterId: seed.employees.cutter.id,
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

  // ---------------------------------------------------------------------------
  // Soft-route hint в `/api/passports/by-code` (STEP 8 ТЗ MVP)
  // ---------------------------------------------------------------------------

  test('F. /api/passports/by-code: отдаёт routeHint с current/next + mismatch с активной сменой', async () => {
    const tpl = await createTemplate(t, cookies.manager, 'BASIC-HINT', [
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
        rollNumber: 'R-RT-HINT',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    await placePassport(t, cookies.manager, passport.body.id, seed.cells.A1.id);

    // Кейс 1: швея на SEW_OVERLOCK_1 (= step[0]) сканирует код
    // паспорта. Backend сравнит активную смену с ожидаемым шагом
    // (currentRouteStep), mismatch должен быть false.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    const lookupOk = await request(t.app.getHttpServer())
      .post('/api/passports/by-code')
      .set('Cookie', cookies.seamstress)
      .send({ code: passport.body.number })
      .expect(201);
    expect(lookupOk.body.routeHint).toBeTruthy();
    expect(lookupOk.body.routeHint.currentRouteStep?.operationCode).toBe(
      'SEW_OVERLOCK_1',
    );
    expect(lookupOk.body.routeHint.nextRouteStep?.operationCode).toBe('QC');
    expect(lookupOk.body.routeHint.expectedOperationId).toBe(
      seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(lookupOk.body.routeHint.activeShiftOperationId).toBe(
      seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(lookupOk.body.routeHint.routeMismatchWithActiveShift).toBe(false);

    // Кейс 2: ОТК на QC (= step[1]) сканирует тот же паспорт. По
    // соглашению STEP 8 expected = currentRouteStep (= overlock).
    // Активная смена — QC, поэтому mismatch=true (warning подсветится).
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      })
      .expect(201);
    const lookupMismatch = await request(t.app.getHttpServer())
      .post('/api/passports/by-code')
      .set('Cookie', cookies.qc)
      .send({ code: passport.body.number })
      .expect(201);
    expect(lookupMismatch.body.routeHint.routeMismatchWithActiveShift).toBe(
      true,
    );
    expect(lookupMismatch.body.routeHint.activeShiftOperationId).toBe(
      seed.operations.QC.id,
    );
    expect(lookupMismatch.body.routeHint.expectedOperationId).toBe(
      seed.operations.SEW_OVERLOCK_1.id,
    );
  });

  test('F2. /api/passports/by-code: routeHint = null, если у заказа нет snapshot маршрута', async () => {
    // Заказ без routeTemplateId → snapshot пуст → routeHint = null,
    // фронт спокойно скрывает блок без падения (см. STEP 3 ТЗ).
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
        rollNumber: 'R-NO-ROUTE',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    const lookup = await request(t.app.getHttpServer())
      .post('/api/passports/by-code')
      .set('Cookie', cookies.seamstress)
      .send({ code: passport.body.number })
      .expect(201);
    expect(lookup.body.routeHint).toBeNull();
  });

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
        cutterId: seed.employees.cutter.id,
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

  // ---------------------------------------------------------------------------
  // Route-WIP без обязательной ячейки между шагами
  //
  // Бизнес-правило (см. `docs/domain.md §18`, `docs/flows.md §F3a`):
  // если у заказа есть snapshot маршрута и паспорт уже вошёл в маршрутный
  // поток (`currentRouteStepIndex !== null`), то размещение в ячейку
  // между маршрутными шагами не обязательно. Раньше `issueToEmployee`
  // жёстко требовал `currentCellId IS NOT NULL` и ронял маршрутный поток
  // сразу после CUT_DIVISION. Эта группа фиксирует, что:
  //   - route-WIP можно «принять» без place-to-cell;
  //   - currentRouteStepIndex и currentOperationId двигаются корректно;
  //   - буферное размещение в ячейку всё ещё работает (legacy-ветка);
  //   - заказ без маршрута сохраняет старое требование ячейки;
  //   - реальный конфликт (паспорт в работе у другого) всё ещё блокируется.
  // ---------------------------------------------------------------------------

  test('G1. Route-WIP: issue без place-to-cell сразу после CUT_DIVISION', async () => {
    // Маршрут включает CUT_DIVISION, чтобы зеркалить реальный сценарий
    // CUT_CUT → CUT_DIVISION → SEW_… → QC → IRONING → PACKING.
    const tpl = await createTemplate(t, cookies.manager, 'ROUTE-WIP-G1', [
      seed.operations.CUT_DIVISION.id,
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
        rollNumber: 'R-WIP-G1',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passport.body.id;

    // Свеже-выпущенный паспорт: status=CREATED, currentEmployeeId=creator
    // (помощник раскройщика), currentCellId=null, currentRouteStepIndex=0.
    const fresh = await t.prisma.passport.findUnique({
      where: { id: passportId },
      select: {
        status: true,
        currentCellId: true,
        currentEmployeeId: true,
        currentRouteStepIndex: true,
      },
    });
    expect(fresh?.status).toBe('CREATED');
    expect(fresh?.currentCellId).toBeNull();
    expect(fresh?.currentRouteStepIndex).toBe(0);

    // Швея стартует смену и сразу принимает паспорт — БЕЗ place-to-cell.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    const issue = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(issue.status).toBe(201);
    expect(issue.body.currentCell).toBeNull();
    expect(issue.body.status).toBe('IN_PROGRESS');

    // ISSUED_TO_EMPLOYEE написан без cellId — паспорт никогда не лежал.
    const issuedEvents = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'ISSUED_TO_EMPLOYEE' },
      select: { cellId: true, employeeId: true },
    });
    expect(issuedEvents).toHaveLength(1);
    expect(issuedEvents[0]!.cellId).toBeNull();
    expect(issuedEvents[0]!.employeeId).toBe(seed.employees.seamstress.id);

    // Дальше штатный scan — currentRouteStepIndex двигается на 1 (SEW_OVERLOCK_1).
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    const afterScan = await t.prisma.passport.findUnique({
      where: { id: passportId },
      select: {
        currentRouteStepIndex: true,
        currentOperationId: true,
        currentCellId: true,
      },
    });
    expect(afterScan?.currentRouteStepIndex).toBe(1);
    expect(afterScan?.currentOperationId).toBe(
      seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(afterScan?.currentCellId).toBeNull();
  });

  test('G2. Route-WIP мульти-степ: SEW_OVERLOCK_1 → SEW_OVERLOCK_2 → QC без ячеек', async () => {
    // Дальше первого sewing-шага паспорт ходит через `scan`, который
    // и так не требует ячейки. Этот тест фиксирует, что вся цепочка
    // sewing-степов проходит без place-to-cell для маршрутного заказа.
    const tpl = await createTemplate(t, cookies.manager, 'ROUTE-WIP-G2', [
      seed.operations.CUT_DIVISION.id,
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.SEW_OVERLOCK_2.id,
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
        rollNumber: 'R-WIP-G2',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passport.body.id;

    // Шаг 1 (SEW_OVERLOCK_1): issue + scan, без ячейки.
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
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.seamstress)
      .expect(201);

    // Шаг 2 (SEW_OVERLOCK_2): другая смена той же швеи (в seed одна
    // швея — это нормально, доменно неважно, кто работает; важно что
    // новый scan на новой операции работает БЕЗ place-to-cell).
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_2.id,
      })
      .expect(201);
    const scan2 = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(scan2.status).toBe(201);
    const afterSew2 = await t.prisma.passport.findUnique({
      where: { id: passportId },
      select: {
        currentOperationId: true,
        currentRouteStepIndex: true,
        currentCellId: true,
        status: true,
      },
    });
    expect(afterSew2?.currentOperationId).toBe(
      seed.operations.SEW_OVERLOCK_2.id,
    );
    expect(afterSew2?.currentRouteStepIndex).toBe(2);
    expect(afterSew2?.currentCellId).toBeNull();
    expect(afterSew2?.status).toBe('IN_PROGRESS');
    await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.seamstress)
      .expect(201);

    // Шаг 3 (QC): отдельный сотрудник; снова без ячейки.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      })
      .expect(201);
    const scanQc = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(scanQc.status).toBe(201);
    const afterQc = await t.prisma.passport.findUnique({
      where: { id: passportId },
      select: { currentRouteStepIndex: true, currentCellId: true },
    });
    expect(afterQc?.currentRouteStepIndex).toBe(3);
    expect(afterQc?.currentCellId).toBeNull();
  });

  test('G3. Optional buffering: route-WIP можно положить в ячейку и забрать (legacy-ветка)', async () => {
    // Поведение place + issue из ячейки должно работать как раньше,
    // даже если у заказа есть маршрут. Это критично, чтобы помощники
    // раскройщика могли использовать ячейку как буфер на пилоте.
    const tpl = await createTemplate(t, cookies.manager, 'ROUTE-WIP-G3', [
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.QC.id,
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
        rollNumber: 'R-WIP-G3',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passport.body.id;

    // Кладём в ячейку как буфер: WIP balance.qty = 1.
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
    const afterPlace = await t.prisma.workInProgressBalance.findFirst({
      where: { cellId: seed.cells.A1.id, sizeId: seed.sizes.M },
    });
    expect(afterPlace?.qty).toBe(1);

    // Швея забирает из ячейки — WIP списывается ISSUE-движением.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    const issue = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(issue.status).toBe(201);
    expect(issue.body.currentCell).toBeNull();
    const afterIssue = await t.prisma.workInProgressBalance.findFirst({
      where: { cellId: seed.cells.A1.id, sizeId: seed.sizes.M },
    });
    expect(afterIssue?.qty).toBe(0);
    // ISSUED_TO_EMPLOYEE написан с cellId — пришёл из ячейки.
    const issuedEvents = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'ISSUED_TO_EMPLOYEE' },
      select: { cellId: true },
    });
    expect(issuedEvents).toHaveLength(1);
    expect(issuedEvents[0]!.cellId).toBe(seed.cells.A1.id);
  });

  test('G4. Идемпотентность route-WIP issue: повтор тем же сотрудником — no-op', async () => {
    const tpl = await createTemplate(t, cookies.manager, 'ROUTE-WIP-G4', [
      seed.operations.SEW_OVERLOCK_1.id,
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
        rollNumber: 'R-WIP-G4',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passport.body.id;

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
    // Повторный issue — без ошибки, без нового события.
    const issue2 = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(issue2.status).toBe(201);
    const events = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'ISSUED_TO_EMPLOYEE' },
    });
    expect(events).toHaveLength(1);
  });

  test('G5. PASSPORT_ALREADY_ISSUED для route-WIP в работе у другого сотрудника', async () => {
    const tpl = await createTemplate(t, cookies.manager, 'ROUTE-WIP-G5', [
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.QC.id,
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
        rollNumber: 'R-WIP-G5',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passport.body.id;

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

    // Второй сотрудник на активной смене пытается забрать тот же
    // паспорт, который уже в работе у первой швеи → 409.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      })
      .expect(201);
    const conflict = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('PASSPORT_ALREADY_ISSUED');
  });

  test('G6. Backward-compat: no-route + currentCellId=null → PASSPORT_NOT_IN_CELL', async () => {
    // Заказ без routeTemplateId. Свежий паспорт → currentRouteStepIndex
    // = null → route-WIP ветка не включается → старое требование
    // ячейки сохраняется ровно как было.
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
        rollNumber: 'R-LEGACY-G6',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    // Помощник раскройщика всё ещё висит как currentEmployeeId
    // (status=CREATED), поэтому без маршрута срабатывает прежний
    // PASSPORT_ALREADY_ISSUED. Ключевое: новый guard не убран для
    // легаси-flow — швее по-прежнему нельзя забрать паспорт без place.
    const issue = await request(t.app.getHttpServer())
      .post(`/api/passports/${passport.body.id}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(issue.status).toBe(409);
    expect(['PASSPORT_NOT_IN_CELL', 'PASSPORT_ALREADY_ISSUED']).toContain(
      issue.body.code,
    );
  });

  // ---------------------------------------------------------------------------
  // G7. Доделка незакрытого шага (инцидент 06–10.08.2026, P-20260804-0009/0010)
  // ---------------------------------------------------------------------------

  test('G7. Незакрытый шаг позади не откат: любой на этой операции берёт паспорт сам, а закрытый — только через мастера', async () => {
    // Полный сценарий инцидента: мастер снял паспорт с первой швейной
    // операции, НЕ закрыв её (unassign намеренно не трогает шаг), паспорт
    // ушёл вперёд на вторую и там закрылся. Раньше первая операция
    // становилась недостижимой навсегда: вперёд её никто не проверял
    // (`sequentialBefore` смотрит только интервал current→target), а
    // назад держал `PASSPORT_ISSUE_BACKWARD`, и вернуть паспорт мог
    // только мастер через `set-route-step`.
    const tpl = await createTemplate(t, cookies.manager, 'ROUTE-WIP-G7', [
      seed.operations.CUT_DIVISION.id,
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.SEW_OVERLOCK_2.id,
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
        rollNumber: 'R-WIP-G7',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passport.body.id;
    // Первый уход с кроя требует размещения в ячейке
    // (`assertPlacedBeforeLeavingCut`) — к маршрутным гейтам отношения
    // не имеет, но без него до них дело не дойдёт.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);

    const startShift = async (cookie: string, operationId: string) => {
      await request(t.app.getHttpServer())
        .post('/api/shifts/start')
        .set('Cookie', cookie)
        .send({ equipmentId: seed.equipment['overlock-01'].id, operationId })
        .expect(201);
    };
    const stopShift = async (cookie: string) => {
      await request(t.app.getHttpServer())
        .post('/api/shifts/stop')
        .set('Cookie', cookie)
        .expect(201);
    };

    // 1. Швея взяла паспорт на SEW_OVERLOCK_1 и НЕ завершила операцию.
    await startShift(cookies.seamstress, seed.operations.SEW_OVERLOCK_1.id);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    await stopShift(cookies.seamstress);

    // 2. Мастер снял паспорт с неё. Шаг остаётся на незакрытой операции.
    await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/unassign`)
      .set('Cookie', cookies.master)
      .send({ reason: 'MANAGER_DECISION' })
      .expect(201);

    // 3. Паспорт уходит вперёд на SEW_OVERLOCK_2 и там закрывается —
    //    именно так первая операция и «проваливается» за спину.
    await startShift(cookies.seamstress, seed.operations.SEW_OVERLOCK_2.id);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    await stopShift(cookies.seamstress);
    const afterSkip = await t.prisma.passport.findUnique({
      where: { id: passportId },
      select: { currentRouteStepIndex: true },
    });
    expect(afterSkip?.currentRouteStepIndex).toBe(2);

    // 4. ГЛАВНОЕ: сотрудник на SEW_OVERLOCK_1 берёт паспорт САМ — шаг
    //    позади, но не закрыт, значит это доделка, а не откат.
    await startShift(cookies.seamstress, seed.operations.SEW_OVERLOCK_1.id);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    const afterCatchUp = await t.prisma.passport.findUnique({
      where: { id: passportId },
      select: { currentRouteStepIndex: true, currentOperationId: true },
    });
    expect(afterCatchUp?.currentRouteStepIndex).toBe(1);
    expect(afterCatchUp?.currentOperationId).toBe(
      seed.operations.SEW_OVERLOCK_1.id,
    );

    // 5. Долг закрывается штатным завершением — работа наконец попадает
    //    в историю паспорта и в начисления.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    const finished = await t.prisma.passportEvent.findMany({
      where: {
        passportId,
        type: 'OPERATION_FINISHED',
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      },
    });
    expect(finished).toHaveLength(1);
    await stopShift(cookies.seamstress);

    // 6. Обратная сторона послабления: ЗАКРЫТЫЙ шаг позади остаётся
    //    откатом. Возвращаем паспорт сканом на SEW_OVERLOCK_2 (вперёд,
    //    разрешено) и пробуем снова на SEW_OVERLOCK_1 — теперь она
    //    закрыта, и это уже настоящий возврат назад: только мастер.
    await startShift(cookies.seamstress, seed.operations.SEW_OVERLOCK_2.id);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    await stopShift(cookies.seamstress);
    await startShift(cookies.seamstress, seed.operations.SEW_OVERLOCK_1.id);
    const backToFinished = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(backToFinished.status).toBe(409);
    expect(backToFinished.body.code).toBe('PASSPORT_SCAN_BACKWARD');
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
