/**
 * Integration-тест бага «после возврата мастером на ОТК повторный
 * скан ОТК не проходит» (28.05.2026, см. диалог /qc + memory).
 *
 * Сценарий:
 *   1. Паспорт прошёл маршрут до ВТО: ОТК завершил проверку
 *      (`QC_PASSED`), ВТО успел отсканировать
 *      (`currentOperationId = IRONING`).
 *   2. Мастер делает `setRouteStep` backward на ОТК с placement
 *      = employee (qc). Бэкенд должен записать
 *      `OPERATION_REWORK_OPENED` на ОТК-операцию + перевести паспорт
 *      на ОТК-шаг.
 *   3. ОТК открывает /qc, стартует смену на qc-station.
 *      `GET /api/qc/incoming-reworks` должен вернуть этот паспорт.
 *   4. ОТК сканирует — `POST /api/passports/:id/scan` НЕ должен падать
 *      (раньше вылетало `PASSPORT_REWORK_PENDING`).
 *   5. `GET /api/qc/passports/:id` отдаёт
 *      `incomingReworkAtQc=true, removedFromQc=false, qcCompletedAt=null`
 *      (старый QC_PASSED от первого прохода в UI не считаем).
 *   6. ОТК нажимает «Проверка выполнена» — пишется НОВЫЙ `QC_PASSED`
 *      + `OPERATION_FINISHED` (закрывает rework). После этого
 *      `incomingReworkAtQc=false`, `hasOpenRework=false`.
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

describeWithDb('integration — QC re-check after master backward', () => {
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
      master: loginAs(t, seed.employees['master']),
      qc: loginAs(t, seed.employees['qc']),
      ironing: loginAs(t, seed.employees['ironing']),
      shopChief: loginAs(t, seed.employees['shop-chief']),
    };
  });

  test('мастер возвращает паспорт на ОТК → ОТК сканирует и заново подтверждает', async () => {
    // 1. Готовим заказ с маршрутом CUT → SEW1 → SEW2 → QC → IRONING.
    const order = await t.prisma.order.create({
      data: {
        number: `O-RECHECK-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 3 },
          ],
        },
      },
    });
    await t.prisma.orderRouteStep.createMany({
      data: [
        { orderId: order.id, index: 0, operationId: seed.operations.CUT_DIVISION.id },
        { orderId: order.id, index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
        { orderId: order.id, index: 2, operationId: seed.operations.SEW_OVERLOCK_2.id },
        { orderId: order.id, index: 3, operationId: seed.operations.QC.id },
        { orderId: order.id, index: 4, operationId: seed.operations.IRONING.id },
      ],
    });

    // 2. Создаём паспорт уже в состоянии «прошёл ОТК → стоит на ВТО».
    //    Имитируем историю событий: QC_PASSED + OPERATION_SCAN(IRONING).
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-RECHECK-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:recheck-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-RECHECK',
        cutDate: new Date(),
        qtyPlan: 3,
        qtyCut: 3,
        qtyGood: 3,
        cutterId: seed.employees['cutter'].id,
        creatorId: seed.employees['cutter'].id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.IRONING.id,
        currentRouteStepIndex: 4,
        currentEmployeeId: seed.employees['ironing'].id,
      },
    });
    // Историю по ОТК (`QC_PASSED`) и переход на ВТО (`OPERATION_SCAN`)
    // пишем напрямую — это ровно те события, что были бы у живого
    // паспорта в этом состоянии. createdAt разносим по времени,
    // чтобы `removedFromQc` (OPERATION_SCAN после QC_PASSED) увидел
    // правильный порядок.
    const qcPassedAt = new Date(Date.now() - 60_000);
    const scanAtVtoAt = new Date(Date.now() - 30_000);
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'QC_PASSED',
        employeeId: seed.employees['qc'].id,
        operationId: seed.operations.QC.id,
        qty: 3,
        createdAt: qcPassedAt,
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'OPERATION_SCAN',
        employeeId: seed.employees['ironing'].id,
        operationId: seed.operations.IRONING.id,
        fromOperationId: seed.operations.QC.id,
        qty: 3,
        createdAt: scanAtVtoAt,
      },
    });
    // OPERATION_FINISHED на ОТК — рудимент: без него `setRouteStep`
    // на QC «не считается за возврат на завершённую операцию».
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'OPERATION_FINISHED',
        employeeId: seed.employees['qc'].id,
        operationId: seed.operations.QC.id,
        qty: 3,
        createdAt: qcPassedAt,
      },
    });

    // 3. Мастер делает backward на ОТК с placement = employee (qc).
    const setStep = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passport.id}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({
        reason: 'ROUTE_CORRECTION',
        comment: 'Возврат на повторную проверку ОТК',
        operationId: seed.operations.QC.id,
        employeeId: seed.employees['qc'].id,
      });
    expect(setStep.status).toBe(201);

    const afterMaster = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passport.id },
    });
    expect(afterMaster.currentOperationId).toBe(seed.operations.QC.id);
    expect(afterMaster.currentRouteStepIndex).toBe(3);
    expect(afterMaster.currentEmployeeId).toBe(seed.employees['qc'].id);
    // Должен появиться новый `OPERATION_REWORK_OPENED` на ОТК-op
    // (тот самый, что мастер пишет при reopenFinishedTarget).
    const reworkEvents = await t.prisma.passportEvent.findMany({
      where: {
        passportId: passport.id,
        type: 'OPERATION_REWORK_OPENED',
        operationId: seed.operations.QC.id,
      },
    });
    expect(reworkEvents).toHaveLength(1);

    // 4. ОТК стартует смену и спрашивает /qc/incoming-reworks.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      })
      .expect(201);

    const inbox = await request(t.app.getHttpServer())
      .get('/api/qc/incoming-reworks')
      .set('Cookie', cookies.qc)
      .expect(200);
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0]).toMatchObject({
      passportId: passport.id,
      passportNumber: passport.number,
      orderNumber: order.number,
      qtyGood: 3,
    });
    expect(typeof inbox.body.items[0].returnedAt).toBe('string');

    // 5. ОТК сканирует — раньше падало `PASSPORT_REWORK_PENDING`,
    //    теперь должно пройти.
    const scan = await request(t.app.getHttpServer())
      .post(`/api/passports/${passport.id}/scan`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(scan.status).toBe(201);

    // 6. QC-карточка показывает «incoming rework» + не схлопывается.
    const detail = await request(t.app.getHttpServer())
      .get(`/api/qc/passports/${passport.id}`)
      .set('Cookie', cookies.qc)
      .expect(200);
    expect(detail.body.incomingReworkAtQc).toBe(true);
    expect(detail.body.reworkPending).toBe(false);
    expect(detail.body.removedFromQc).toBe(false);
    expect(detail.body.qcCompletedAt).toBeNull(); // re-check ещё не подтверждён
    expect(detail.body.canCompleteQc).toBe(true);
    expect(detail.body.canRecordDefect).toBe(true);
    expect(detail.body.reworkAssignment).toBeNull();

    // 7. «Проверка выполнена» — должна пройти и закрыть rework.
    const complete = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passport.id}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    expect(typeof complete.body.qcCompletedAt).toBe('string');
    expect(complete.body.incomingReworkAtQc).toBe(false);

    // Должен появиться НОВЫЙ QC_PASSED (всего теперь два) +
    // OPERATION_FINISHED для ОТК (закрывает rework). Старый
    // FINISHED от первого прохода был; новый — от re-check.
    const passedEvents = await t.prisma.passportEvent.findMany({
      where: { passportId: passport.id, type: 'QC_PASSED' },
    });
    expect(passedEvents).toHaveLength(2);
    const finishedQcEvents = await t.prisma.passportEvent.findMany({
      where: {
        passportId: passport.id,
        operationId: seed.operations.QC.id,
        type: 'OPERATION_FINISHED',
      },
    });
    expect(finishedQcEvents).toHaveLength(2);

    // 8. Inbox теперь пуст — rework закрыт.
    const inboxAfter = await request(t.app.getHttpServer())
      .get('/api/qc/incoming-reworks')
      .set('Cookie', cookies.qc)
      .expect(200);
    expect(inboxAfter.body.items).toHaveLength(0);
  });
});
