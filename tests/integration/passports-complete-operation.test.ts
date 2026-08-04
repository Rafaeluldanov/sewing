/**
 * Integration-тесты `PassportsService.completeOperationByEmployee` —
 * фокусированный набор инвариантов «комплит не может откатывать
 * паспорт назад» и «`OPERATION_FINISHED.operationId` всегда отражает
 * фактически завершаемую операцию (`activeShift.operationId`)».
 *
 * Покрываем кейсы из ТЗ §8 («TESTS / Integration A,B»):
 *
 *   A. complete после issue из CUT_DIVISION (без OPERATION_SCAN) —
 *      должен записать `OPERATION_FINISHED.operationId` = activeShift,
 *      а не CUT_DIVISION; passport.currentOperationId/RouteStepIndex
 *      обновляются на завершённую sewing-операцию.
 *
 *   B. complete не может откатить паспорт назад: если активная смена
 *      указывает на step РАНЬШЕ текущего `currentRouteStepIndex`,
 *      backend отвечает 409 PASSPORT_COMPLETE_BACKWARD и состояние
 *      паспорта не меняется. Откат — прерогатива мастера.
 *
 *   C. AuditLog `PASSPORT_OPERATION_COMPLETED` содержит расширенный
 *      payload (`completedOperationId`, `before`, `after`).
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

describeWithDb('integration — passports.completeOperationByEmployee', () => {
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
      seamstress: loginAs(t, seed.employees['seamstress']),
    };
  });

  /**
   * Заказ + snapshot маршрута CUT_DIVISION → SEW_OVERLOCK_1 →
   * SEW_OVERLOCK_2 → QC + одна швейная смена + один паспорт в
   * указанном начальном состоянии. Возвращает id паспорта.
   */
  async function setup(opts: {
    /** Начальная операция паспорта (по умолчанию CUT_DIVISION). */
    currentOperationCode?: 'CUT_DIVISION' | 'SEW_OVERLOCK_1' | 'SEW_OVERLOCK_2';
    /** Начальный индекс шага маршрута (по умолчанию 0). */
    currentRouteStepIndex: number;
    /** Операция активной смены швеи (по умолчанию SEW_OVERLOCK_1). */
    shiftOperationCode?: 'SEW_OVERLOCK_1' | 'SEW_OVERLOCK_2';
  }): Promise<{ passportId: string; orderId: string }> {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: `O-COMP-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 6 },
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
      ],
    });
    const shiftOpCode = opts.shiftOperationCode ?? 'SEW_OVERLOCK_1';
    const shiftOpId =
      shiftOpCode === 'SEW_OVERLOCK_1'
        ? seed.operations.SEW_OVERLOCK_1.id
        : seed.operations.SEW_OVERLOCK_2.id;
    // Один оверлок (`overlock-01`) в seed разрешает обе sewing-операции
    // (см. `EQUIPMENT_SEEDS.allowedOperationCodes`), так что shift на
    // SEW_OVERLOCK_1 и SEW_OVERLOCK_2 заводится на одном станке.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: shiftOpId,
        startedAt: today,
      },
    });
    const opCode = opts.currentOperationCode ?? 'CUT_DIVISION';
    const opId =
      opCode === 'CUT_DIVISION'
        ? seed.operations.CUT_DIVISION.id
        : opCode === 'SEW_OVERLOCK_1'
          ? seed.operations.SEW_OVERLOCK_1.id
          : seed.operations.SEW_OVERLOCK_2.id;
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-COMP-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:comp-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-COMP',
        cutDate: today,
        qtyPlan: 6,
        qtyCut: 6,
        qtyGood: 6,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: opId,
        currentEmployeeId: seed.employees.seamstress.id,
        currentRouteStepIndex: opts.currentRouteStepIndex,
      },
    });
    return { passportId: passport.id, orderId: order.id };
  }

  // -------------------------------------------------------------------------
  // A. complete после issue из CUT
  // -------------------------------------------------------------------------

  test('A. complete после issue из CUT завершает активную sewing-операцию (НЕ CUT_DIVISION)', async () => {
    // Реальный продакшен-кейс из ТЗ:
    //   CREATED → CUT_DIVISION → CELL_PLACED → ISSUED_TO_EMPLOYEE
    //   → (без OPERATION_SCAN) complete-operation
    // До фикса OPERATION_FINISHED записывал operationId =
    // passport.currentOperationId, т.е. CUT_DIVISION, и журнал событий
    // показывал «швея завершила деление кроя на оверлоке» — абсурд.
    const { passportId } = await setup({
      currentOperationCode: 'CUT_DIVISION',
      currentRouteStepIndex: 0,
      shiftOperationCode: 'SEW_OVERLOCK_1',
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // Паспорт обновлён: currentOperationId = SEW_OVERLOCK_1,
    // currentRouteStepIndex = 1, currentEmployeeId/CellId сняты.
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.currentEmployeeId).toBeNull();
    expect(passport.currentCellId).toBeNull();
    expect(passport.currentOperationId).toBe(
      seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(passport.currentRouteStepIndex).toBe(1);
    expect(passport.status).toBe('IN_PROGRESS');

    // OPERATION_FINISHED ссылается на завершённую sewing-операцию,
    // а не на «застрявший» CUT_DIVISION.
    const events = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'OPERATION_FINISHED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.operationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(events[0]!.operationId).not.toBe(seed.operations.CUT_DIVISION.id);

    // AuditLog payload содержит расширенный набор полей: completed*,
    // before/after — этого достаточно для ретроспективы движения.
    const audits = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'PASSPORT',
        entityId: passportId,
        event: 'PASSPORT_OPERATION_COMPLETED',
      },
    });
    expect(audits).toHaveLength(1);
    const payload = audits[0]!.payload as {
      completedOperationId: string;
      before: { currentOperationId: string | null; currentRouteStepIndex: number | null };
      after: { currentOperationId: string | null; currentRouteStepIndex: number | null };
    };
    expect(payload.completedOperationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(payload.before.currentOperationId).toBe(seed.operations.CUT_DIVISION.id);
    expect(payload.before.currentRouteStepIndex).toBe(0);
    expect(payload.after.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(payload.after.currentRouteStepIndex).toBe(1);
  });

  // -------------------------------------------------------------------------
  // B. complete не может двигать паспорт назад
  // -------------------------------------------------------------------------

  test('B. complete не может откатить паспорт назад (idx 2 → активная смена SEW_OVERLOCK_1) → 409', async () => {
    // Паспорт уже на SEW_OVERLOCK_2 (idx=2), но швея почему-то
    // открыла смену на SEW_OVERLOCK_1 (idx=1) и пытается «завершить».
    // Это классический сценарий «завершить чужую/прошлую операцию» —
    // именно его раньше писали в журнал как regression.
    const { passportId } = await setup({
      currentOperationCode: 'SEW_OVERLOCK_2',
      currentRouteStepIndex: 2,
      shiftOperationCode: 'SEW_OVERLOCK_1',
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_COMPLETE_BACKWARD');

    // Состояние паспорта не должно поменяться.
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.currentRouteStepIndex).toBe(2);
    expect(passport.currentOperationId).toBe(
      seed.operations.SEW_OVERLOCK_2.id,
    );
    expect(passport.currentEmployeeId).toBe(seed.employees.seamstress.id);

    // OPERATION_FINISHED-событие НЕ должно записываться.
    const events = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'OPERATION_FINISHED' },
    });
    expect(events).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // B'. complete на той же операции (idempotent forward) разрешён
  // -------------------------------------------------------------------------

  test('B-бис. complete на той же операции (idx 2 == shift idx 2) разрешён, idx не меняется', async () => {
    // Switch уже на SEW_OVERLOCK_2, смена на SEW_OVERLOCK_2 — это не
    // backward, а легитимное «комплит текущей операции». Семантика
    // WIP-buffer'а: complete фиксирует ✔ на текущем step, а не
    // прыгает на следующий. Index не должен поменяться.
    const { passportId } = await setup({
      currentOperationCode: 'SEW_OVERLOCK_2',
      currentRouteStepIndex: 2,
      shiftOperationCode: 'SEW_OVERLOCK_2',
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.currentRouteStepIndex).toBe(2);
    expect(passport.currentOperationId).toBe(
      seed.operations.SEW_OVERLOCK_2.id,
    );
    expect(passport.currentEmployeeId).toBeNull();

    const events = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'OPERATION_FINISHED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.operationId).toBe(seed.operations.SEW_OVERLOCK_2.id);
  });

  // -------------------------------------------------------------------------
  // D. смена сменилась между «взял» и «завершил»
  // -------------------------------------------------------------------------

  test('D. complete закрывает операцию ОТКРЫТОГО НАЗНАЧЕНИЯ, а не операцию новой смены', async () => {
    // Инцидент 04.08.2026, заказ 02-00001: швея взяла 12 паспортов на
    // ПРЯМОСТРОЧКЕ, наутро пересканировала смену на ОВЕРЛОК и через 39
    // секунд пакетно их завершила. Вся дневная выработка записалась на
    // операцию новой смены — которой в маршруте заказа нет вообще: шаг
    // маршрута остался незакрытым, а сделка ушла по чужой расценке
    // (64,10 ₽ вместо 615,40 ₽). Смена — общая на все паспорта на руках
    // и меняется когда угодно; назначение привязано к паспорту.
    const { passportId } = await setup({
      currentOperationCode: 'SEW_OVERLOCK_1',
      currentRouteStepIndex: 1,
      shiftOperationCode: 'SEW_OVERLOCK_2',
    });
    // Паспорт выдан на SEW_OVERLOCK_1 (вчера), смена уже на _2 (сегодня).
    await t.prisma.passportEvent.create({
      data: {
        passportId,
        type: 'ISSUED_TO_EMPLOYEE',
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        qty: 6,
      },
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const events = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'OPERATION_FINISHED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.operationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(events[0]!.operationId).not.toBe(seed.operations.SEW_OVERLOCK_2.id);

    // Паспорт остаётся на своём шаге — complete фиксирует ✔ текущей
    // операции и не перепрыгивает вперёд на шаг новой смены.
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(passport.currentRouteStepIndex).toBe(1);

    // Деньги идут за фактически закрытой операцией, а не за операцией
    // смены — ровно это и разъехалось в инциденте.
    const entries = await t.prisma.operationEntry.findMany({
      where: { passportId },
    });
    for (const entry of entries) {
      expect(entry.operationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    }
  });
});
