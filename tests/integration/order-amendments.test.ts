/**
 * Интеграционные тесты фичи «Правка заказа в производстве» (order
 * amendments, флаг FEATURE_ORDER_AMENDMENTS) — ФАЗА 1: количество по
 * размерам.
 *
 * Проверяем контракт `OrderAmendmentsService` через HTTP:
 *   - правка разрешена только в IN_PRODUCTION (иначе 409
 *     ORDER_NOT_AMENDABLE);
 *   - увеличение тиража поднимает агрегат OrderItem, поразмерный план
 *     единственной расцветки и снимок задачи раскроя (CuttingTaskSizeRow),
 *     не трогая уже выпущенные паспорта;
 *   - нельзя опустить план ниже уже раскроенного (409 AMENDMENT_BELOW_CUT);
 *   - GET-состояние отдаёт текущий план + раскрой по размерам.
 *
 * Каркас — как `e2e-production-flow.test.ts`: seedMinimal + create/start
 * заказа через API, паспорт через API, затем наши эндпоинты.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  loginAs,
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

const QTY = 20;

describeWithDb('integration — order amendments (quantity)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let manager: string;

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
    manager = loginAs(t, seed.employees['shop-chief']);
  });

  /** Заказ с одним размером M, запущен в производство. Возвращает id. */
  async function createStartedOrder(qty = QTY): Promise<string> {
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: `TPL-AMEND-${Date.now()}`,
        name: 'Amendment route',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.CUT_DIVISION.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 2, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    const orderRes = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        routeTemplateId: tpl.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: qty }],
      })
      .expect(201);
    const orderId: string = orderRes.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', manager)
      .expect(201);
    return orderId;
  }

  /** Выпустить паспорт с раскроем qtyCut по размеру M. */
  async function cutPassport(orderId: string, qtyCut: number): Promise<void> {
    await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: `R-${qtyCut}-${Date.now()}`,
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
  }

  test('DRAFT-заказ — правка количества запрещена (409 ORDER_NOT_AMENDABLE)', async () => {
    const orderRes = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: QTY }],
      })
      .expect(201);
    const orderId: string = orderRes.body.id;

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/quantities`)
      .set('Cookie', manager)
      .send({ changes: [{ sizeId: seed.sizes.M, newQtyPlan: QTY + 5 }], reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_NOT_AMENDABLE');
  });

  test('GET-состояние отдаёт план и раскрой по размерам', async () => {
    const orderId = await createStartedOrder();
    await cutPassport(orderId, 8);

    const res = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/amendments/quantities`)
      .set('Cookie', manager)
      .expect(200);

    expect(res.body.editable).toBe(true);
    expect(res.body.multiVariant).toBe(false);
    const rowM = res.body.rows.find((r: any) => r.sizeId === seed.sizes.M);
    expect(rowM).toBeTruthy();
    expect(rowM.currentQtyPlan).toBe(QTY);
    expect(rowM.qtyCut).toBe(8);
  });

  test('увеличение тиража поднимает OrderItem, OrderVariantSize и CuttingTaskSizeRow', async () => {
    const orderId = await createStartedOrder();

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/quantities`)
      .set('Cookie', manager)
      .send({
        changes: [{ sizeId: seed.sizes.M, newQtyPlan: QTY + 15 }],
        reason: 'клиент увеличил тираж',
      })
      .expect(201);
    expect(res.body.applied).toBe(true);

    // Агрегат заказа обновлён.
    const item = await t.prisma.orderItem.findFirstOrThrow({
      where: { orderId, sizeId: seed.sizes.M },
    });
    expect(item.qtyPlan).toBe(QTY + 15);

    // Инвариант OrderItem == Σ OrderVariantSize (single variant).
    const vSizes = await t.prisma.orderVariantSize.findMany({
      where: { variant: { orderId }, sizeId: seed.sizes.M },
    });
    expect(vSizes.reduce((s, v) => s + v.qtyPlan, 0)).toBe(QTY + 15);

    // Снимок задачи раскроя тоже поднят.
    const sizeRow = await t.prisma.cuttingTaskSizeRow.findFirstOrThrow({
      where: { task: { orderId }, sizeId: seed.sizes.M },
    });
    expect(sizeRow.qtyPlan).toBe(QTY + 15);

    // Аудит записан.
    const audit = await t.prisma.auditLog.findFirst({
      where: { entityType: 'ORDER', entityId: orderId, event: 'ORDER_QTY_AMENDED' },
    });
    expect(audit).toBeTruthy();
  });

  test('нельзя опустить план ниже раскроя (409 AMENDMENT_BELOW_CUT)', async () => {
    const orderId = await createStartedOrder();
    await cutPassport(orderId, 12);

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/quantities`)
      .set('Cookie', manager)
      .send({
        changes: [{ sizeId: seed.sizes.M, newQtyPlan: 10 }],
        reason: 'попытка занизить',
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AMENDMENT_BELOW_CUT');

    // План НЕ изменился.
    const item = await t.prisma.orderItem.findFirstOrThrow({
      where: { orderId, sizeId: seed.sizes.M },
    });
    expect(item.qtyPlan).toBe(QTY);
  });

  test('уменьшение до уровня раскроя (не ниже) — разрешено', async () => {
    const orderId = await createStartedOrder();
    await cutPassport(orderId, 12);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/quantities`)
      .set('Cookie', manager)
      .send({
        changes: [{ sizeId: seed.sizes.M, newQtyPlan: 12 }],
        reason: 'свести план к факту кроя',
      })
      .expect(201);

    const item = await t.prisma.orderItem.findFirstOrThrow({
      where: { orderId, sizeId: seed.sizes.M },
    });
    expect(item.qtyPlan).toBe(12);
  });

  // ---- ФАЗА 2: размерность --------------------------------------------

  test('GET-состояние размерности: текущий размер + доступный для добавления', async () => {
    const orderId = await createStartedOrder();

    const res = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/amendments/sizes`)
      .set('Cookie', manager)
      .expect(200);

    expect(res.body.editable).toBe(true);
    const curM = res.body.current.find((r: any) => r.sizeId === seed.sizes.M);
    expect(curM).toBeTruthy();
    expect(curM.removable).toBe(true); // ещё нет раскроя
    const availL = res.body.available.find((r: any) => r.sizeId === seed.sizes.L);
    expect(availL).toBeTruthy();
  });

  test('добавление размера создаёт OrderItem, OrderVariantSize и CuttingTaskSizeRow', async () => {
    const orderId = await createStartedOrder();

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/sizes`)
      .set('Cookie', manager)
      .send({
        add: [{ sizeId: seed.sizes.L, qtyPlan: 7 }],
        reason: 'клиент добавил размер L',
      })
      .expect(201);
    expect(res.body.applied).toBe(true);

    const item = await t.prisma.orderItem.findFirstOrThrow({
      where: { orderId, sizeId: seed.sizes.L },
    });
    expect(item.qtyPlan).toBe(7);

    const vSize = await t.prisma.orderVariantSize.findFirstOrThrow({
      where: { variant: { orderId }, sizeId: seed.sizes.L },
    });
    expect(vSize.qtyPlan).toBe(7);

    const sizeRow = await t.prisma.cuttingTaskSizeRow.findFirstOrThrow({
      where: { task: { orderId }, sizeId: seed.sizes.L },
    });
    expect(sizeRow.qtyPlan).toBe(7);

    const audit = await t.prisma.auditLog.findFirst({
      where: { entityType: 'ORDER', entityId: orderId, event: 'ORDER_SIZE_AMENDED' },
    });
    expect(audit).toBeTruthy();
  });

  test('добавление размера, который уже в заказе → 409 ALREADY_IN_ORDER', async () => {
    const orderId = await createStartedOrder();

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/sizes`)
      .set('Cookie', manager)
      .send({
        add: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
        reason: 'дубль',
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AMENDMENT_SIZE_ALREADY_IN_ORDER');
  });

  test('удаление не начатого размера — убирает строку', async () => {
    const orderId = await createStartedOrder();
    // Добавляем L, затем сразу убираем (по нему нет работы).
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/sizes`)
      .set('Cookie', manager)
      .send({ add: [{ sizeId: seed.sizes.L, qtyPlan: 7 }], reason: 'add L' })
      .expect(201);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/sizes`)
      .set('Cookie', manager)
      .send({ remove: [seed.sizes.L], reason: 'убрать L' })
      .expect(201);

    const item = await t.prisma.orderItem.findFirst({
      where: { orderId, sizeId: seed.sizes.L },
    });
    expect(item).toBeNull();
    const sizeRow = await t.prisma.cuttingTaskSizeRow.findFirst({
      where: { task: { orderId }, sizeId: seed.sizes.L },
    });
    expect(sizeRow).toBeNull();
  });

  test('удаление размера с раскроем → 409 SIZE_HAS_WORK', async () => {
    const orderId = await createStartedOrder();
    await cutPassport(orderId, 5); // раскроили M

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/sizes`)
      .set('Cookie', manager)
      .send({ remove: [seed.sizes.M], reason: 'попытка убрать раскроенный' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AMENDMENT_SIZE_HAS_WORK');

    // Размер на месте.
    const item = await t.prisma.orderItem.findFirst({
      where: { orderId, sizeId: seed.sizes.M },
    });
    expect(item).toBeTruthy();
  });

  // ---- ФАЗА 3: добавить операцию ---------------------------------------

  test('добавление операции в конец маршрута', async () => {
    const orderId = await createStartedOrder(); // 3 шага: CUT, SEW, QC

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/operations`)
      .set('Cookie', manager)
      .send({
        operationId: seed.operations.PACKING.id,
        afterIndex: null,
        reason: 'добавили упаковку',
      })
      .expect(201);
    expect(res.body.applied).toBe(true);
    expect(res.body.insertedIndex).toBe(3);

    const steps = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(steps.map((s) => s.operationId)).toEqual([
      seed.operations.CUT_DIVISION.id,
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.QC.id,
      seed.operations.PACKING.id,
    ]);

    const audit = await t.prisma.auditLog.findFirst({
      where: {
        entityType: 'ORDER',
        entityId: orderId,
        event: 'ORDER_OPERATION_ADDED',
      },
    });
    expect(audit).toBeTruthy();
  });

  test('вставка операции впереди фронта сдвигает индексы', async () => {
    const orderId = await createStartedOrder();
    await cutPassport(orderId, 5); // паспорт на шаге 0 → фронт = 0

    // Вставляем IRONING после шага 1 (insertIndex=2, > фронта=0).
    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/operations`)
      .set('Cookie', manager)
      .send({
        operationId: seed.operations.IRONING.id,
        afterIndex: 1,
        reason: 'добавили ВТО перед ОТК',
      })
      .expect(201);
    expect(res.body.insertedIndex).toBe(2);

    const steps = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    // QC (был index 2) сдвинулся на 3, IRONING встал на 2.
    expect(steps.map((s) => s.operationId)).toEqual([
      seed.operations.CUT_DIVISION.id,
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.IRONING.id,
      seed.operations.QC.id,
    ]);
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });

  test('вставка НЕ впереди фронта → 409 BEHIND_FRONTIER', async () => {
    const orderId = await createStartedOrder();
    await cutPassport(orderId, 5);
    // Симулируем, что паспорт продвинулся до шага 2 (фронт = 2).
    await t.prisma.passport.updateMany({
      where: { orderId },
      data: { currentRouteStepIndex: 2 },
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/operations`)
      .set('Cookie', manager)
      .send({
        operationId: seed.operations.IRONING.id,
        afterIndex: 1, // insertIndex=2, НЕ > фронта=2
        reason: 'попытка вставить позади фронта',
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AMENDMENT_OPERATION_BEHIND_FRONTIER');
  });

  test('добавление операции, уже присутствующей в маршруте → 409', async () => {
    const orderId = await createStartedOrder();

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/operations`)
      .set('Cookie', manager)
      .send({
        operationId: seed.operations.QC.id, // уже в маршруте
        afterIndex: null,
        reason: 'дубль',
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AMENDMENT_OPERATION_ALREADY_IN_ROUTE');
  });

  // ---- ФАЗА 3.1: правка маршрута целиком (вкладка «Маршрут») -----------

  test('состояние маршрута отдаёт фронт, флаги правки и данные для чипов', async () => {
    const orderId = await createStartedOrder();
    await cutPassport(orderId, 5); // паспорт на шаге 0 → фронт = 0

    const res = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/amendments/operations`)
      .set('Cookie', manager)
      .expect(200);

    expect(res.body.frontierIndex).toBe(0);
    const steps = res.body.steps as {
      index: number;
      operationCode: string;
      operationCategory: string | null;
      movable: boolean;
      removable: boolean;
    }[];
    // Шаг 0 держит паспорт — заморожен; хвост свободен.
    expect(steps.map((s) => s.movable)).toEqual([false, true, true]);
    expect(steps.map((s) => s.removable)).toEqual([false, true, true]);
    expect(steps[0].operationCode).toBe('CUT_DIVISION');
    expect(steps[0].operationCategory).toBeTruthy();
    // Палитра отдаёт категорию — по ней UI группирует и красит чипы.
    expect(res.body.availableOperations.length).toBeGreaterThan(0);
    expect(res.body.availableOperations[0]).toHaveProperty('category');
  });

  test('маршрут целиком: вставка + перестановка за один сабмит', async () => {
    const orderId = await createStartedOrder(); // CUT, SEW, QC
    await cutPassport(orderId, 5); // фронт = 0 (шаг CUT заморожен)

    const res = await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/amendments/route`)
      .set('Cookie', manager)
      .send({
        steps: [
          { operationId: seed.operations.CUT_DIVISION.id },
          { operationId: seed.operations.PACKING.id },
          { operationId: seed.operations.QC.id },
          { operationId: seed.operations.SEW_OVERLOCK_1.id },
        ],
        reason: 'добавили упаковку, ОТК перед пошивом',
      })
      .expect(200);

    expect(res.body.applied).toBe(true);
    expect(res.body.addedCount).toBe(1);
    expect(res.body.removedCount).toBe(0);
    // Переставлены оба выживших шага: их относительный порядок сменился.
    // Сдвиг индексов из-за вставки перестановкой НЕ считается.
    expect(res.body.movedCount).toBe(2);

    const steps = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(steps.map((s) => s.operationId)).toEqual([
      seed.operations.CUT_DIVISION.id,
      seed.operations.PACKING.id,
      seed.operations.QC.id,
      seed.operations.SEW_OVERLOCK_1.id,
    ]);
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);

    // Паспорт остался на своём шаге — правка хвоста его не трогает.
    const passport = await t.prisma.passport.findFirst({ where: { orderId } });
    expect(passport?.currentRouteStepIndex).toBe(0);

    const audit = await t.prisma.auditLog.findFirst({
      where: {
        entityType: 'ORDER',
        entityId: orderId,
        event: 'ORDER_ROUTE_AMENDED',
      },
    });
    expect(audit).toBeTruthy();
  });

  test('маршрут целиком: удаление шага впереди фронта', async () => {
    const orderId = await createStartedOrder(); // CUT, SEW, QC
    await cutPassport(orderId, 5); // фронт = 0

    const res = await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/amendments/route`)
      .set('Cookie', manager)
      .send({
        steps: [
          { operationId: seed.operations.CUT_DIVISION.id },
          { operationId: seed.operations.SEW_OVERLOCK_1.id },
        ],
        reason: 'ОТК не нужен на этом тираже',
      })
      .expect(200);
    expect(res.body.removedCount).toBe(1);
    expect(res.body.summary).toContain('−');

    const steps = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(steps.map((s) => s.operationId)).toEqual([
      seed.operations.CUT_DIVISION.id,
      seed.operations.SEW_OVERLOCK_1.id,
    ]);
    expect(steps.map((s) => s.index)).toEqual([0, 1]);
  });

  test('маршрут целиком: параллельная группа проставляется обоим шагам', async () => {
    const orderId = await createStartedOrder();

    await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/amendments/route`)
      .set('Cookie', manager)
      .send({
        steps: [
          { operationId: seed.operations.CUT_DIVISION.id },
          { operationId: seed.operations.SEW_OVERLOCK_1.id, parallelGroup: 1 },
          { operationId: seed.operations.QC.id, parallelGroup: 1 },
        ],
        reason: 'пошив и ОТК параллельно',
      })
      .expect(200);

    const steps = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(steps.map((s) => s.parallelGroup)).toEqual([null, 1, 1]);
  });

  test('правка замороженного префикса → 409 ROUTE_FRONTIER_CHANGED', async () => {
    const orderId = await createStartedOrder();
    await cutPassport(orderId, 5);
    // Паспорт продвинулся до шага 1 → индексы 0..1 заморожены.
    await t.prisma.passport.updateMany({
      where: { orderId },
      data: { currentRouteStepIndex: 1 },
    });

    const res = await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/amendments/route`)
      .set('Cookie', manager)
      .send({
        steps: [
          { operationId: seed.operations.SEW_OVERLOCK_1.id },
          { operationId: seed.operations.CUT_DIVISION.id },
          { operationId: seed.operations.QC.id },
        ],
        reason: 'попытка переставить пройденное',
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AMENDMENT_ROUTE_FRONTIER_CHANGED');

    // Снимок не тронут.
    const steps = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(steps.map((s) => s.operationId)).toEqual([
      seed.operations.CUT_DIVISION.id,
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.QC.id,
    ]);
  });

  test('маршрут без изменений → applied=false, аудита нет', async () => {
    const orderId = await createStartedOrder();

    const res = await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/amendments/route`)
      .set('Cookie', manager)
      .send({
        steps: [
          { operationId: seed.operations.CUT_DIVISION.id },
          { operationId: seed.operations.SEW_OVERLOCK_1.id },
          { operationId: seed.operations.QC.id },
        ],
        reason: 'ничего не поменяли',
      })
      .expect(200);
    expect(res.body.applied).toBe(false);

    const audit = await t.prisma.auditLog.count({
      where: { entityId: orderId, event: 'ORDER_ROUTE_AMENDED' },
    });
    expect(audit).toBe(0);
  });

  test('правка маршрута не в производстве → 409 ORDER_NOT_AMENDABLE', async () => {
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: `TPL-AMEND-DRAFT-${Date.now()}`,
        name: 'Amendment draft route',
        steps: {
          create: [{ index: 0, operationId: seed.operations.QC.id }],
        },
      },
    });
    const orderRes = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        routeTemplateId: tpl.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .put(`/api/orders/${orderRes.body.id}/amendments/route`)
      .set('Cookie', manager)
      .send({
        steps: [{ operationId: seed.operations.PACKING.id }],
        reason: 'правка черновика',
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_NOT_AMENDABLE');
  });

  // ---- Журнал правок ---------------------------------------------------

  test('журнал правок возвращает применённые события с summary и причиной', async () => {
    const orderId = await createStartedOrder();

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/quantities`)
      .set('Cookie', manager)
      .send({
        changes: [{ sizeId: seed.sizes.M, newQtyPlan: QTY + 3 }],
        reason: 'рост тиража',
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/amendments/operations`)
      .set('Cookie', manager)
      .send({
        operationId: seed.operations.PACKING.id,
        afterIndex: null,
        reason: 'добавили упаковку',
      })
      .expect(201);

    const res = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/amendments/history`)
      .set('Cookie', manager)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    const kinds = res.body.map((e: any) => e.kind);
    expect(kinds).toContain('quantity');
    expect(kinds).toContain('operation');

    const qty = res.body.find((e: any) => e.kind === 'quantity');
    expect(qty.reason).toBe('рост тиража');
    expect(qty.summary).toContain('→'); // «M 20→23»
    expect(qty.actorName).toBeTruthy(); // имя менеджера подставлено

    const op = res.body.find((e: any) => e.kind === 'operation');
    expect(op.summary).toContain('позицию');
  });
});
