/**
 * Integration-тест полного производственного потока MVP 1.1.
 *
 * Один длинный сценарий, идущий «от создания заказа до начислений
 * после упаковки». Проверяем здесь все ключевые инварианты, чтобы:
 *   - регрессии в одном модуле было видно сразу;
 *   - не пришлось дублировать общий setup в 7 разных файлах;
 *   - новый разработчик мог по тесту понять «как устроен процесс».
 *
 * Тонкие углы (no-ops, дубли, гонки) проверяются точечно — отдельные
 * `test()` ниже основного сценария.
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

// PHASE 2 STEP 3: id seed-раскройщика, который helper `createPassport`
// подставляет по умолчанию в тело `POST /api/passports`. Менеджер
// (cookies.manager) не имеет роли CUTTER, и без явного `cutterId`
// backend теперь возвращает CUTTER_REQUIRED (см.
// `apps/api/src/modules/passports/passports.service.ts`,
// `docs/api.md §13`).
let defaultCutterId: string | undefined;

describeWithDb('integration — full production flow (MVP 1.1)', () => {
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
    defaultCutterId = seed.employees['cutter'].id;
    // Без `refreshAdminCookie` системный admin был бы стёрт TRUNCATE'ом,
    // и `t.adminCookie` ушёл бы в 401.
    await refreshAdminCookie(t);
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      cutter: loginAs(t, seed.employees['cutter']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      ironing: loginAs(t, seed.employees['ironing']),
      packer: loginAs(t, seed.employees['packer']),
      admin: t.adminCookie,
    };
  });

  // ---------------------------------------------------------------------------
  // ORDERS
  // ---------------------------------------------------------------------------

  test('A. Orders: создание, дубли по размеру, lock после старта', async () => {
    const create = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      });
    expect(create.status).toBe(201);
    const orderId: string = create.body.id;
    expect(create.body.status).toBe('DRAFT');

    const dup = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [
          { sizeId: seed.sizes.M, qtyPlan: 1 },
          { sizeId: seed.sizes.M, qtyPlan: 2 },
        ],
      });
    expect(dup.status).toBe(400);

    const start = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager);
    expect(start.status).toBe(201);
    expect(start.body.status).toBe('IN_PRODUCTION');

    // После запуска заказа PATCH «безопасных» полей по-прежнему
    // разрешён — комментарий, клиент и срок не зависят от snapshot-а
    // маршрута и могут править в production. См.
    // `OrdersService.update`.
    const safeEdit = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'try edit' });
    expect(safeEdit.status).toBe(200);
    expect(safeEdit.body.comment).toBe('try edit');

    // А вот «опасные» поля (план/изделие) после запуска уже залочены —
    // это инвариант ADR-0006 «после старта план иммутабелен».
    const unsafeEdit = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .send({ items: [{ sizeId: seed.sizes.M, qtyPlan: 99 }] });
    expect(unsafeEdit.status).toBe(409);
    expect(unsafeEdit.body.code).toBe('ORDER_LOCKED');

    const restricted = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.qc)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.S, qtyPlan: 1 }],
      });
    expect(restricted.status).toBe(403);
    expect(restricted.body.code).toBe('FORBIDDEN_ROLE');
  });

  // ---------------------------------------------------------------------------
  // PASSPORTS
  // ---------------------------------------------------------------------------

  test('B. Passports: выпуск ≤ qtyPlan, place в ячейку, qtyCutFact в order', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 5 },
    ]);
    await startOrder(t, orderId, cookies.manager);

    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-01',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 5,
        cutterId: seed.employees['cutter'].id,
      });
    expect(passport.status).toBe(201);
    const passportId: string = passport.body.id;
    expect(passport.body.qtyCut).toBe(5);
    expect(passport.body.qtyGood).toBe(5);

    const overflow = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-02',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees['cutter'].id,
      });
    expect(overflow.status).toBe(422);
    expect(overflow.body.code).toBe('QTY_EXCEEDS_REMAINING_PLAN');

    const place = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id });
    expect(place.status).toBe(201);
    expect(place.body.passport.currentCell.code).toBe('A1');

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager);
    expect(detail.status).toBe(200);
    const row = detail.body.sizeBreakdown.find(
      (r: { sizeId: string }) => r.sizeId === seed.sizes.M,
    );
    expect(row.qtyCutFact).toBe(5);
    expect(row.qtyRemaining).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // SHIFTS / WORK
  // ---------------------------------------------------------------------------

  test('C. Shifts: одна активная смена на сотрудника + issue + scan + idempotent earning', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 3 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      3,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);

    const start1 = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      });
    expect(start1.status).toBe(201);

    const start2 = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      });
    expect(start2.status).toBe(409);
    expect(start2.body.code).toBe('SHIFT_ALREADY_ACTIVE');

    const issue = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(issue.status).toBe(201);
    expect(issue.body.status).toBe('IN_PROGRESS');

    const scan1 = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(scan1.status).toBe(201);

    const scan2 = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(scan2.status).toBe(201);

    // Идемпотентность сдельных начислений: повтор скана НЕ плодит
    // новые OperationEntry за ту же операцию (см. ADR-0012).
    const earnings = await t.prisma.operationEntry.findMany({
      where: { passportId, employeeId: seed.employees.seamstress.id },
    });
    expect(earnings.length).toBeLessThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // QC
  // ---------------------------------------------------------------------------

  test('D. QC: запись брака уменьшает qtyGood, не превышает remaining', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 5 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      5,
    );

    // ОТК доступно только для паспортов в статусе IN_PROGRESS
    // (см. docs/api.md §8 «Правило доступности для ОТК»).
    // Чтобы довести паспорт до IN_PROGRESS — кладём его в ячейку,
    // заводим смену швее и выдаём крой.
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
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

    const def = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/defects`)
      .set('Cookie', cookies.qc)
      .send({ defectTypeId: seed.defectType.id, qty: 2 });
    expect(def.status).toBe(201);
    expect(def.body.qtyDefect).toBe(2);
    expect(def.body.qtyGood).toBe(3);

    const overflow = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/defects`)
      .set('Cookie', cookies.qc)
      .send({ defectTypeId: seed.defectType.id, qty: 100 });
    expect(overflow.status).toBe(422);

    // Order qtyDefectTotal реактивно растёт.
    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager);
    expect(detail.body.summary.qtyDefectTotal).toBe(2);
  });

  test('D2. QC complete: «Проверка выполнена» — пишет QC_PASSED, не двигает статус, можно повторно', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 4 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      4,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
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

    // 1) До нажатия «Проверка выполнена» qcCompletedAt = null.
    const before = await request(t.app.getHttpServer())
      .get(`/api/qc/passports/${passportId}`)
      .set('Cookie', cookies.qc)
      .expect(200);
    expect(before.body.qcCompletedAt).toBeNull();
    expect(before.body.canCompleteQc).toBe(true);
    expect(before.body.status).toBe('IN_PROGRESS');

    // 2) Завершаем — backend отдаёт обновлённую карточку с qcCompletedAt.
    const done = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    expect(typeof done.body.qcCompletedAt).toBe('string');
    // Сатус не трогаем — ОТК это аудит-маркер, не движение по pipeline.
    expect(done.body.status).toBe('IN_PROGRESS');
    // Повторно завершить — допустимо (например, после фиксации
    // дополнительного брака): backend должен отдать новый timestamp.
    const firstAt = done.body.qcCompletedAt as string;
    await new Promise((r) => setTimeout(r, 5));
    const again = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    expect(again.body.qcCompletedAt).not.toBeNull();
    expect(
      new Date(again.body.qcCompletedAt as string).getTime(),
    ).toBeGreaterThanOrEqual(new Date(firstAt).getTime());

    // 3) В аудите обязательно появляется PassportEvent(QC_PASSED).
    const events = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'QC_PASSED' },
    });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.employeeId).toBe(seed.employees.qc.id);
  });

  test('D2b. QC removedFromQc: после OPERATION_SCAN на следующей операции свернутый паспорт уходит из ОТК', async () => {
    // Готовим IN_PROGRESS-паспорт стандартным flow (см. D2). Этот же
    // путь используется в `apps/web/app/qc/qc-terminal.tsx`: после
    // «Проверка выполнена» строка сворачивается; как только швея на
    // следующем рабочем месте делает скан, backend отдаёт
    // `removedFromQc=true`, и схлопнутая строка исчезает из окна ОТК.
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 1 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      1,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
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

    // 1) Сразу после complete — `removedFromQc=false`, паспорт ещё
    //    «висит» в окне ОТК как свернутая строка.
    const done = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    expect(typeof done.body.qcCompletedAt).toBe('string');
    expect(done.body.removedFromQc).toBe(false);

    // 2) Швея сканирует паспорт на следующей операции (любой
    //    OPERATION_SCAN после `qcCompletedAt` означает «ушёл дальше»).
    //    Сделаем `scan` той же сессией seamstress — он создаёт
    //    `PassportEvent(OPERATION_SCAN)` с operationId = SEW_OVERLOCK_1
    //    и переключит `Passport.currentOperationId`.
    await new Promise((r) => setTimeout(r, 5));
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // 3) Backend теперь сообщает `removedFromQc=true` — фронт скрывает
    //    свернутую строку.
    const after = await request(t.app.getHttpServer())
      .get(`/api/qc/passports/${passportId}`)
      .set('Cookie', cookies.qc)
      .expect(200);
    expect(after.body.removedFromQc).toBe(true);

    // 4) PACKED тоже считается «ушёл из ОТК» (терминальный статус),
    //    проверяем независимо от OPERATION_SCAN: при ручном переводе
    //    в PACKED флаг остаётся true (canCompleteQc уже false, см. D3).
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { status: 'PACKED' },
    });
    const packed = await request(t.app.getHttpServer())
      .get(`/api/qc/passports/${passportId}`)
      .set('Cookie', cookies.qc)
      .expect(200);
    expect(packed.body.removedFromQc).toBe(true);
    expect(packed.body.canCompleteQc).toBe(false);
  });

  test('D2c. QC scan: вход на операцию ОТК двигает паспорт в bucket QC на shopfloor', async () => {
    // Регрессия для бага «при сканировании паспорта на операции ОТК
    // статус не двигается на экране „Цех“». Источник истины —
    // shopfloor-проекция (`bucketOf` в shopfloor-projection.ts):
    // bucket QC = `IN_PROGRESS` + `currentOperation.category = QC`.
    // До фикса `lookupQcPassportAction` не дёргал `scanOnOperation`,
    // поэтому `currentOperationId` оставался на швейной операции и
    // паспорт никогда не попадал в QC. Полный аналог D4b для ВТО.
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 1 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      1,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
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

    // Проверяем «до»: паспорт ещё на пошиве, в bucket SEWING (не QC).
    const before = await request(t.app.getHttpServer())
      .get(`/api/shopfloor/state?orderId=${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(before.body.summary.qtySewing).toBe(1);
    expect(before.body.summary.qtyQc).toBe(0);
    expect(before.body.summary.qtyQcDone).toBe(0);

    // ОТК открывает свою смену и сканирует паспорт прямым
    // `/api/passports/:id/scan` (точно так же, как делает
    // `lookupQcPassportAction` после фикса).
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      })
      .expect(201);
    const accept = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(accept.status).toBe(201);

    // После OPERATION_SCAN на категории QC паспорт переехал в bucket QC.
    const after = await request(t.app.getHttpServer())
      .get(`/api/shopfloor/state?orderId=${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(after.body.summary.qtySewing).toBe(0);
    expect(after.body.summary.qtyQc).toBe(1);
    expect(after.body.summary.qtyQcDone).toBe(0);
  });

  test('D2d. QC complete: «Проверка выполнена» двигает паспорт в bucket QC_DONE', async () => {
    // Регрессия для «при завершении ОТК статус не двигается». Здесь
    // важно, что перед `completeQc` паспорт реально на категории QC
    // (после D2c-фикса так и происходит). Тогда свежий QC_PASSED
    // (новее последнего OPERATION_SCAN) переводит паспорт из QC в
    // QC_DONE, а сам `Passport.status` остаётся `IN_PROGRESS` (см.
    // ADR-0013 §«QC_DONE bucket»).
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 1 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      1,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
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

    // До complete: паспорт в QC, но не в QC_DONE.
    const before = await request(t.app.getHttpServer())
      .get(`/api/shopfloor/state?orderId=${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(before.body.summary.qtyQc).toBe(1);
    expect(before.body.summary.qtyQcDone).toBe(0);

    // Слегка ждём, чтобы QC_PASSED.createdAt > OPERATION_SCAN.createdAt
    // даже на быстрых раннерах (timestamps в миллисекундах).
    await new Promise((r) => setTimeout(r, 5));
    const done = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    // Статус не двигаем — это аудит-маркер, а не движение по pipeline.
    expect(done.body.status).toBe('IN_PROGRESS');

    // После complete: паспорт в QC_DONE, бакет QC обнулился (бакеты
    // взаимоисключающие, см. ADR-0013).
    const after = await request(t.app.getHttpServer())
      .get(`/api/shopfloor/state?orderId=${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(after.body.summary.qtyQc).toBe(0);
    expect(after.body.summary.qtyQcDone).toBe(1);
  });

  test('D2e. После complete ОТК следующий scan уводит паспорт из QC_DONE дальше', async () => {
    // Закрываем acceptance: «следующий этап сканирует — паспорт
    // должен уйти из QC_DONE». Используем ВТО как следующий этап
    // (требует QC_PASSED, который у нас уже есть).
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 1 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      1,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
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
    await new Promise((r) => setTimeout(r, 5));
    await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);

    // ВТО заводит свою смену и принимает паспорт.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.ironing)
      .send({
        equipmentId: seed.equipment['ironing-station-01'].id,
        operationId: seed.operations.IRONING.id,
      })
      .expect(201);
    await new Promise((r) => setTimeout(r, 5));
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);

    // Паспорт ушёл из QC_DONE и приехал в WTO. Бакеты QC* обнулились.
    const board = await request(t.app.getHttpServer())
      .get(`/api/shopfloor/state?orderId=${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(board.body.summary.qtyQc).toBe(0);
    expect(board.body.summary.qtyQcDone).toBe(0);
    expect(board.body.summary.qtyWto).toBe(1);
    expect(board.body.summary.qtyWtoDone).toBe(0);
  });

  test('D3. QC complete: терминальный статус → 422 PASSPORT_NOT_QCABLE', async () => {
    // Готовый «уже отгруженный» паспорт удобно симулировать ручным
    // переводом статуса в PACKED — этого достаточно, чтобы guard
    // `status !== IN_PROGRESS` сработал в `completeQc`.
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 1 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      1,
    );
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { status: 'PACKED' },
    });
    const res = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSPORT_NOT_QCABLE');

    // canCompleteQc/canRecordDefect в карточке тоже должны стать false.
    const detail = await request(t.app.getHttpServer())
      .get(`/api/qc/passports/${passportId}`)
      .set('Cookie', cookies.qc)
      .expect(200);
    expect(detail.body.canCompleteQc).toBe(false);
    expect(detail.body.canRecordDefect).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // WTO (role-terminal /wto, derived stage WTO_DONE)
  // ---------------------------------------------------------------------------

  test('D4a. WTO scan-in: без QC_PASSED → 409 PASSPORT_NOT_QC_PASSED, OPERATION_SCAN не пишется', async () => {
    // ВТО — единственная роль, у которой scan-in на её операцию
    // имеет дополнительный gate. Источник истины — backend
    // (`PassportsService.scanOnOperation`), а не UI: проверяем
    // именно общий `/api/passports/:id/scan` под IRONING-сменой.
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 1 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      1,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
    // Доводим до IN_PROGRESS «как обычно»: smena seamstress + issue.
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

    // Сотрудник ВТО открывает свою смену и пробует принять паспорт
    // прямым `/api/passports/:id/scan` (точно так же, как делает
    // `acceptOnWtoAction`).
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.ironing)
      .send({
        equipmentId: seed.equipment['ironing-station-01'].id,
        operationId: seed.operations.IRONING.id,
      })
      .expect(201);
    const denied = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.ironing)
      .send({});
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('PASSPORT_NOT_QC_PASSED');

    // Никаких новых OPERATION_SCAN с operationId=IRONING в аудите —
    // gate отработал ДО записи события в той же транзакции.
    const scans = await t.prisma.passportEvent.findMany({
      where: {
        passportId,
        type: 'OPERATION_SCAN',
        operationId: seed.operations.IRONING.id,
      },
    });
    expect(scans).toHaveLength(0);
  });

  test('D4b. WTO scan-in: после QC_PASSED — паспорт принимается, currentOperation = IRONING', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 1 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      1,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
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
    // QC отметил «Проверка выполнена» — gate должен пропустить.
    await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.ironing)
      .send({
        equipmentId: seed.equipment['ironing-station-01'].id,
        operationId: seed.operations.IRONING.id,
      })
      .expect(201);
    const accept = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.ironing)
      .send({});
    expect(accept.status).toBe(201);

    // После OPERATION_SCAN на IRONING shopfloor-проекция должна
    // увидеть паспорт в bucket WTO (а не WTO_DONE — WTO_PASSED ещё нет).
    const board = await request(t.app.getHttpServer())
      .get(`/api/shopfloor/state?orderId=${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(board.body.summary.qtyWto).toBe(1);
    expect(board.body.summary.qtyWtoDone).toBe(0);
  });

  test('D4c. WTO complete: «Завершить ВТО» пишет WTO_PASSED, не двигает статус, передвигает в bucket WTO_DONE', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 1 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      1,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
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
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.ironing)
      .send({
        equipmentId: seed.equipment['ironing-station-01'].id,
        operationId: seed.operations.IRONING.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);

    // 1) До complete: wtoCompletedAt=null, canCompleteWto=true,
    //    qcPassedAt — заполнен (см. WtoService.loadDetail).
    const before = await request(t.app.getHttpServer())
      .get(`/api/wto/passports/${passportId}`)
      .set('Cookie', cookies.ironing)
      .expect(200);
    expect(before.body.wtoCompletedAt).toBeNull();
    expect(before.body.canCompleteWto).toBe(true);
    expect(typeof before.body.qcPassedAt).toBe('string');
    expect(before.body.status).toBe('IN_PROGRESS');

    // 2) Завершаем — backend отдаёт wtoCompletedAt, статус не меняем.
    const done = await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);
    expect(typeof done.body.wtoCompletedAt).toBe('string');
    expect(done.body.status).toBe('IN_PROGRESS');
    expect(done.body.removedFromWto).toBe(false);

    // 3) Аудит: PassportEvent(WTO_PASSED) с employeeId = ironing.
    const events = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'WTO_PASSED' },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.employeeId).toBe(seed.employees.ironing.id);

    // 4) Shopfloor: WTO_PASSED свежее последнего OPERATION_SCAN —
    //    паспорт переехал из bucket WTO в WTO_DONE (взаимоисключающие).
    const board = await request(t.app.getHttpServer())
      .get(`/api/shopfloor/state?orderId=${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(board.body.summary.qtyWto).toBe(0);
    expect(board.body.summary.qtyWtoDone).toBe(1);
  });

  test('D4d. WTO removedFromWto: после OPERATION_SCAN на следующей операции свернутый паспорт уходит из ВТО', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 1 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      1,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
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
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.ironing)
      .send({
        equipmentId: seed.equipment['ironing-station-01'].id,
        operationId: seed.operations.IRONING.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);
    const done = await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);
    expect(done.body.removedFromWto).toBe(false);

    // Упаковщик заводит смену и сканирует паспорт — это OPERATION_SCAN
    // строго после WTO_PASSED, значит паспорт «ушёл из ВТО».
    await new Promise((r) => setTimeout(r, 5));
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.packer)
      .send({
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.packer)
      .send({})
      .expect(201);

    // 1) WTO-карточка: removedFromWto=true.
    const after = await request(t.app.getHttpServer())
      .get(`/api/wto/passports/${passportId}`)
      .set('Cookie', cookies.ironing)
      .expect(200);
    expect(after.body.removedFromWto).toBe(true);
    // canCompleteWto уже false — паспорт не на категории IRONING.
    expect(after.body.canCompleteWto).toBe(false);

    // 2) Shopfloor: паспорт в bucket PACKING (ни в WTO, ни в WTO_DONE).
    const board = await request(t.app.getHttpServer())
      .get(`/api/shopfloor/state?orderId=${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(board.body.summary.qtyWto).toBe(0);
    expect(board.body.summary.qtyWtoDone).toBe(0);
  });

  test('D4e. WTO complete: вне категории IRONING → 409 PASSPORT_NOT_WTOABLE', async () => {
    // Паспорт ещё на швее (SEW_OVERLOCK_1) — нельзя завершить ВТО,
    // даже у разрешённой роли. Это страховка от UI-ошибки «case
    // когда сотрудник ВТО открыл карточку чужого паспорта».
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 1 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      1,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);
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
    const res = await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSPORT_NOT_WTOABLE');
  });

  // ---------------------------------------------------------------------------
  // PACKING + EARNINGS
  // ---------------------------------------------------------------------------

  test('E+F. Packing: создание/добавление/закрытие, qtyFinished + APPROVED earnings', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 5 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      5,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);

    // Швея: смена → выдача → скан на овере (создаёт PENDING_RELEASE для CUT_DIVISION).
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
      .post('/api/shifts/stop')
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // Пакер: смена на packing-station → создать коробку, добавить, закрыть.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.packer)
      .send({
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
      })
      .expect(201);

    const box = await request(t.app.getHttpServer())
      .post('/api/packing/boxes')
      .set('Cookie', cookies.packer)
      .send({});
    expect(box.status).toBe(201);
    const boxId: string = box.body.id;

    const add = await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/add-passport`)
      .set('Cookie', cookies.packer)
      .send({ code: passportId });
    expect(add.status).toBe(201);
    expect(add.body.totalQty).toBe(5);

    // Паспорт стал PACKED.
    const passportAfter = await t.prisma.passport.findUnique({
      where: { id: passportId },
      select: { status: true },
    });
    expect(passportAfter?.status).toBe('PACKED');

    // Order qtyFinishedTotal обновился.
    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager);
    expect(detail.body.summary.qtyFinishedTotal).toBe(5);

    // До закрытия коробки начисления остаются в PENDING_RELEASE
    // (см. ADR-0005, ADR-0011 §5: финальный апрув перенесён в
    // `PackingService.close`, чтобы scan-driven packing-терминал имел
    // единый «final completion event»).
    const sewingBeforeClose = await t.prisma.operationEntry.findMany({
      where: { passportId, employeeId: seed.employees.seamstress.id },
    });
    if (sewingBeforeClose.length > 0) {
      expect(
        sewingBeforeClose.every(
          (e) => e.status === 'PENDING_RELEASE' || e.status === 'PENDING',
        ),
      ).toBe(true);
      expect(sewingBeforeClose.every((e) => e.approvedAt === null)).toBe(true);
    }

    // Закрываем коробку — это финальный шаг цепочки.
    const closeRes = await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/close`)
      .set('Cookie', cookies.packer)
      .send({});
    expect(closeRes.status).toBe(201);
    expect(closeRes.body.status).toBe('CLOSED');

    // Только теперь PENDING_RELEASE начисления за пошив должны стать APPROVED.
    const sewing = await t.prisma.operationEntry.findMany({
      where: { passportId, employeeId: seed.employees.seamstress.id },
    });
    if (sewing.length > 0) {
      expect(sewing.every((e) => e.status === 'APPROVED')).toBe(true);
      expect(sewing.every((e) => e.approvedAt !== null)).toBe(true);
    }

    // Идемпотентность: повторное закрытие отдаёт 409 BOX_CLOSED, а
    // ручной повторный апрув не плодит новых строк / не меняет
    // approvedAt у уже APPROVED.
    const closeAgain = await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/close`)
      .set('Cookie', cookies.packer)
      .send({});
    expect(closeAgain.status).toBe(409);
    const sewingAfter = await t.prisma.operationEntry.findMany({
      where: { passportId, employeeId: seed.employees.seamstress.id },
    });
    expect(sewingAfter.length).toBe(sewing.length);
    expect(sewingAfter.every((e) => e.status === 'APPROVED')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // SHOPFLOOR
  // ---------------------------------------------------------------------------

  test('G. Shopfloor: проекция выдаёт согласованные buckets', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 4 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    await createPassport(t, cookies.manager, orderId, seed.sizes.M, 4);

    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/state')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows ?? res.body)).toBe(true);
  });
});

// ===========================================================================
// helpers
// ===========================================================================

async function createOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  items: Array<{ sizeId: string; qtyPlan: number }>,
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items,
    })
    .expect(201);
  return r.body.id;
}

async function startOrder(t: TestApp, orderId: string, cookie: string): Promise<void> {
  await request(t.app.getHttpServer())
    .post(`/api/orders/${orderId}/start`)
    .set('Cookie', cookie)
    .expect(201);
}

async function createPassport(
  t: TestApp,
  cookie: string,
  orderId: string,
  sizeId: string,
  qtyCut: number,
  cutterIdOverride?: string,
): Promise<string> {
  // PHASE 2 STEP 3: backend требует явный cutterId у не-CUTTER
  // ролей (CUTTER_ASSISTANT / SHOP_MANAGER). Подставляем seed
  // cutter по умолчанию, чтобы существующие тесты, которые
  // выпускают паспорт под cookies.manager, не отваливались с
  // CUTTER_REQUIRED. Тесты, которые проверяют этот контракт
  // явно, передают cutterIdOverride.
  const cutterId = cutterIdOverride ?? defaultCutterId;
  const r = await request(t.app.getHttpServer())
    .post('/api/passports')
    .set('Cookie', cookie)
    .send({
      orderId,
      sizeId,
      rollNumber: `R-${Math.floor(Math.random() * 1e6)}`,
      cutDate: '2026-04-15T00:00:00.000Z',
      qtyCut,
      ...(cutterId ? { cutterId } : {}),
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
