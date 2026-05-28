/**
 * Integration-тесты модуля «Действия мастера над паспортами»
 * (Stage 2, см. `apps/api/src/modules/master-actions/*`,
 * `docs/domain.md §10b`, `docs/flows.md §F-Master actions`,
 * `docs/screens.md §8a.2.1`).
 *
 * Покрываем инварианты ТЗ §8 «TESTS / Integration»:
 *
 *   1. master can unassign passport — `currentEmployeeId = null`,
 *      `currentOperationId` / `currentRouteStepIndex` сохраняются;
 *   2. master can transfer passport to another employee — назначается
 *      target, `currentCellId = null`, `status = IN_PROGRESS`;
 *   3. master can return passport to cell — `currentCellId` обновлён,
 *      `currentEmployeeId = null`, `CellContent` инкрементнут на
 *      `qtyCut`;
 *   4. master can set route step only to valid route operation —
 *      валидный шаг применяется, невалидный (нет в snapshot) → 409;
 *   5. reason required — `400 VALIDATION_ERROR` при пустом body;
 *   6. non-master forbidden — `SEAMSTRESS` получает `403 FORBIDDEN_ROLE`;
 *   7. PACKED/CANCELLED cannot be changed — `409 PASSPORT_TERMINAL`;
 *   8. AuditLog created with before/after — для каждого действия одна
 *      запись `MASTER_PASSPORT_*` с `before`/`after`-снэпшотом и
 *      `reason` в payload.
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

describeWithDb('integration — master actions (Stage 2)', () => {
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
      seamstress: loginAs(t, seed.employees['seamstress']),
    };
  });

  /**
   * Создаёт заказ + один паспорт + snapshot маршрута и возвращает их id.
   * `currentEmployeeId` по умолчанию — швея (для тестов unassign /
   * transfer). Маршрут: `CUT_DIVISION` (idx=0) → `SEW_OVERLOCK_1` (1) →
   * `SEW_OVERLOCK_2` (2) → `QC` (3).
   */
  async function setupPassport(opts?: {
    status?: 'CREATED' | 'IN_PROGRESS' | 'PACKED' | 'CANCELLED';
    currentEmployeeId?: string | null;
    currentCellId?: string | null;
    currentOperationCode?:
      | 'CUT_DIVISION'
      | 'SEW_OVERLOCK_1'
      | 'SEW_OVERLOCK_2'
      | 'QC';
    currentRouteStepIndex?: number | null;
    qtyCut?: number;
    withRouteSnapshot?: boolean;
  }): Promise<{
    passportId: string;
    orderId: string;
  }> {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: `O-MA-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 5 },
          ],
        },
      },
    });

    if (opts?.withRouteSnapshot !== false) {
      await t.prisma.orderRouteStep.createMany({
        data: [
          { orderId: order.id, index: 0, operationId: seed.operations.CUT_DIVISION.id },
          { orderId: order.id, index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
          { orderId: order.id, index: 2, operationId: seed.operations.SEW_OVERLOCK_2.id },
          { orderId: order.id, index: 3, operationId: seed.operations.QC.id },
        ],
      });
    }

    const status = opts?.status ?? 'IN_PROGRESS';
    const currentEmployeeId =
      opts?.currentEmployeeId === undefined
        ? seed.employees.seamstress.id
        : opts.currentEmployeeId;
    const currentOpCode = opts?.currentOperationCode ?? 'SEW_OVERLOCK_1';
    const currentRouteStepIndex =
      opts?.currentRouteStepIndex === undefined
        ? 1
        : opts.currentRouteStepIndex;

    const passport = await t.prisma.passport.create({
      data: {
        number: `P-MA-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:ma-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-MA',
        cutDate: today,
        qtyPlan: opts?.qtyCut ?? 5,
        qtyCut: opts?.qtyCut ?? 5,
        qtyGood: opts?.qtyCut ?? 5,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status,
        currentOperationId:
          currentOpCode === 'CUT_DIVISION'
            ? seed.operations.CUT_DIVISION.id
            : currentOpCode === 'SEW_OVERLOCK_1'
              ? seed.operations.SEW_OVERLOCK_1.id
              : currentOpCode === 'SEW_OVERLOCK_2'
                ? seed.operations.SEW_OVERLOCK_2.id
                : seed.operations.QC.id,
        currentRouteStepIndex,
        currentEmployeeId,
        currentCellId: opts?.currentCellId ?? null,
      },
    });
    return { passportId: passport.id, orderId: order.id };
  }

  // -------------------------------------------------------------------------
  // 1. UNASSIGN
  // -------------------------------------------------------------------------

  test('unassign: снимает с сотрудника, сохраняет операцию и шаг', async () => {
    const { passportId } = await setupPassport({
      currentRouteStepIndex: 1,
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/unassign`)
      .set('Cookie', cookies.master)
      .send({ reason: 'WRONG_SCAN', comment: 'ошибочный скан' })
      .expect(201);

    expect(res.body.passport).toMatchObject({
      id: passportId,
      currentEmployeeId: null,
      currentRouteStepIndex: 1,
    });
    expect(res.body.passport.currentOperation?.id).toBe(
      seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(res.body.before.currentEmployeeId).toBe(
      seed.employees.seamstress.id,
    );

    const inDb = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(inDb?.currentEmployeeId).toBeNull();
    expect(inDb?.currentRouteStepIndex).toBe(1);
    expect(inDb?.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(inDb?.status).toBe('IN_PROGRESS');

    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toBe('MASTER_PASSPORT_UNASSIGNED');
    const payload = audits[0]!.payload as {
      reason: string;
      before: { currentEmployeeId: string | null };
      after: { currentEmployeeId: string | null };
    };
    expect(payload.reason).toBe('WRONG_SCAN');
    expect(payload.before.currentEmployeeId).toBe(
      seed.employees.seamstress.id,
    );
    expect(payload.after.currentEmployeeId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. TRANSFER TO EMPLOYEE
  // -------------------------------------------------------------------------

  test('transfer-to-employee: назначает target, currentCellId сбрасывается', async () => {
    // Создаём вторую швею (target).
    const target = await t.prisma.employee.create({
      data: {
        login: 'seamstress-target',
        fullName: 'Target Seamstress',
        role: 'SEAMSTRESS',
        active: true,
        pinHash: '$2a$04$abcdefghijklmnopqrstuv',
      },
    });
    const { passportId } = await setupPassport({
      currentCellId: seed.cells.A1.id,
    });

    const res = await request(t.app.getHttpServer())
      .post(
        `/api/master-actions/passports/${passportId}/transfer-to-employee`,
      )
      .set('Cookie', cookies.master)
      .send({ reason: 'SHIFT_HANDOVER', employeeQr: `EMPLOYEE:${target.id}` })
      .expect(201);

    expect(res.body.passport.currentEmployeeId).toBe(target.id);
    expect(res.body.passport.currentCell).toBeNull();
    expect(res.body.passport.status).toBe('IN_PROGRESS');

    const inDb = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(inDb?.currentEmployeeId).toBe(target.id);
    expect(inDb?.currentCellId).toBeNull();

    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toBe('MASTER_PASSPORT_TRANSFERRED');
    const payload = audits[0]!.payload as { targetEmployeeId: string };
    expect(payload.targetEmployeeId).toBe(target.id);
  });

  test('transfer-to-employee: target деактивирован → 409 TARGET_EMPLOYEE_INACTIVE', async () => {
    const target = await t.prisma.employee.create({
      data: {
        login: 'seamstress-inactive',
        fullName: 'Inactive Seamstress',
        role: 'SEAMSTRESS',
        active: false,
        pinHash: '$2a$04$abcdefghijklmnopqrstuv',
      },
    });
    const { passportId } = await setupPassport();

    const res = await request(t.app.getHttpServer())
      .post(
        `/api/master-actions/passports/${passportId}/transfer-to-employee`,
      )
      .set('Cookie', cookies.master)
      .send({ reason: 'MANAGER_DECISION', employeeId: target.id })
      .expect(409);
    expect(res.body?.code).toBe('TARGET_EMPLOYEE_INACTIVE');
  });

  // -------------------------------------------------------------------------
  // 3. RETURN TO CELL
  // -------------------------------------------------------------------------

  test('return-to-cell: ставит ячейку и инкрементит WorkInProgressBalance', async () => {
    const { passportId } = await setupPassport({ qtyCut: 7 });
    const cell = seed.cells.A1;

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/return-to-cell`)
      .set('Cookie', cookies.master)
      .send({ reason: 'CELL_CORRECTION', cellQr: cell.qrCode })
      .expect(201);

    expect(res.body.passport.currentCell?.id).toBe(cell.id);
    expect(res.body.passport.currentEmployeeId).toBeNull();

    const inDb = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(inDb?.currentCellId).toBe(cell.id);
    expect(inDb?.currentEmployeeId).toBeNull();

    const wipBalance = await t.prisma.workInProgressBalance.findFirst({
      where: { cellId: cell.id, sizeId: seed.sizes.M },
    });
    expect(wipBalance?.qty).toBe(7);

    // Идемпотентность: повторный вызов на ту же ячейку — noop, баланс не двоится.
    await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/return-to-cell`)
      .set('Cookie', cookies.master)
      .send({ reason: 'CELL_CORRECTION', cellId: cell.id })
      .expect(201);
    const wipAfter = await t.prisma.workInProgressBalance.findFirst({
      where: { cellId: cell.id, sizeId: seed.sizes.M },
    });
    expect(wipAfter?.qty).toBe(7);

    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId },
    });
    expect(audits.map((a) => a.event)).toEqual([
      'MASTER_PASSPORT_RETURNED_TO_CELL',
      'MASTER_PASSPORT_RETURNED_TO_CELL',
    ]);
    const second = audits[1]!.payload as { noop?: boolean };
    expect(second.noop).toBe(true);
  });

  test('return-to-cell: ячейка деактивирована → 409 CELL_INACTIVE', async () => {
    await t.prisma.cell.update({
      where: { id: seed.cells.A1.id },
      data: { active: false },
    });
    const { passportId } = await setupPassport();

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/return-to-cell`)
      .set('Cookie', cookies.master)
      .send({ reason: 'WRONG_SCAN', cellId: seed.cells.A1.id })
      .expect(409);
    expect(res.body?.code).toBe('CELL_INACTIVE');
  });

  // -------------------------------------------------------------------------
  // 4. SET ROUTE STEP
  // -------------------------------------------------------------------------

  test('set-route-step: применяет валидный шаг snapshot маршрута', async () => {
    const { passportId } = await setupPassport({
      currentRouteStepIndex: 1,
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({ reason: 'ROUTE_CORRECTION', routeStepIndex: 2 })
      .expect(201);

    expect(res.body.passport.currentRouteStepIndex).toBe(2);
    expect(res.body.passport.currentOperation?.id).toBe(
      seed.operations.SEW_OVERLOCK_2.id,
    );
    expect(res.body.passport.currentEmployeeId).toBeNull();
    expect(res.body.passport.currentCell).toBeNull();
    expect(res.body.passport.status).toBe('IN_PROGRESS');

    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toBe('MASTER_PASSPORT_ROUTE_STEP_SET');
    const payload = audits[0]!.payload as {
      routeStepIndex: number;
      operationId: string;
    };
    expect(payload.routeStepIndex).toBe(2);
    expect(payload.operationId).toBe(seed.operations.SEW_OVERLOCK_2.id);
  });

  test('set-route-step: индекс вне snapshot → 409 ROUTE_STEP_NOT_IN_SNAPSHOT', async () => {
    const { passportId } = await setupPassport();

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({ reason: 'ROUTE_CORRECTION', routeStepIndex: 999 })
      .expect(409);
    expect(res.body?.code).toBe('ROUTE_STEP_NOT_IN_SNAPSHOT');
  });

  // -------------------------------------------------------------------------
  // 4b. SET ROUTE STEP — backward движения (rollback) и required cell
  // -------------------------------------------------------------------------

  test('set-route-step backward без placement → 400 MASTER_BACKWARD_ROUTE_REQUIRES_PLACEMENT', async () => {
    // Паспорт стоит на шаге 2 (SEW_OVERLOCK_2), мастер пытается
    // откатить на шаг 0 (CUT_DIVISION) без указания ни ячейки, ни
    // сотрудника. По инварианту «нет тихого rollback» backend обязан
    // отказать с понятным кодом ошибки до открытия транзакции —
    // иначе паспорт окажется «в воздухе» (no employee + no cell),
    // и это нельзя будет отличить от ошибки в БД.
    const { passportId } = await setupPassport({
      currentRouteStepIndex: 2,
      currentOperationCode: 'SEW_OVERLOCK_2',
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({ reason: 'ROUTE_CORRECTION', routeStepIndex: 0 })
      .expect(400);
    expect(res.body?.code).toBe('MASTER_BACKWARD_ROUTE_REQUIRES_PLACEMENT');

    // Состояние паспорта не должно поменяться, audit-лог тоже не пишется
    // (проверка происходит до транзакции).
    const inDb = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(inDb?.currentRouteStepIndex).toBe(2);
    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId },
    });
    expect(audits).toHaveLength(0);
  });

  test('set-route-step backward с cell И employee одновременно → 400 VALIDATION_ERROR', async () => {
    // DTO-инвариант: оба placement'а сразу — противоречие («либо в
    // ячейке, либо на человеке»). Zod refine отсекает ещё до сервиса.
    const { passportId } = await setupPassport({
      currentRouteStepIndex: 2,
      currentOperationCode: 'SEW_OVERLOCK_2',
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({
        reason: 'ROUTE_CORRECTION',
        routeStepIndex: 0,
        cellQr: seed.cells.A1.qrCode,
        employeeQr: `EMPLOYEE:${seed.employees.seamstress.id}`,
      })
      .expect(400);
    expect(res.body?.code).toBe('VALIDATION_ERROR');
  });

  test('set-route-step backward с cell: размещает в ячейку и пишет direction=BACKWARD', async () => {
    // Паспорт на SEW_OVERLOCK_2 (idx=2), мастер откатывает на
    // CUT_DIVISION (idx=0) с указанием ячейки. После применения:
    //   - currentRouteStepIndex/Operation указывают на CUT_DIVISION,
    //   - currentEmployeeId = null,
    //   - currentCellId = указанная ячейка,
    //   - CellContent[size] += qtyCut,
    //   - AuditLog.payload.direction = 'BACKWARD',
    //     requiredCellPlacement = true, cellId присутствует.
    const cell = seed.cells.A1;
    const { passportId } = await setupPassport({
      qtyCut: 8,
      currentRouteStepIndex: 2,
      currentOperationCode: 'SEW_OVERLOCK_2',
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({
        reason: 'ROUTE_CORRECTION',
        routeStepIndex: 0,
        cellQr: cell.qrCode,
      })
      .expect(201);

    expect(res.body.passport.currentRouteStepIndex).toBe(0);
    expect(res.body.passport.currentOperation?.id).toBe(
      seed.operations.CUT_DIVISION.id,
    );
    expect(res.body.passport.currentEmployeeId).toBeNull();
    expect(res.body.passport.currentCell?.id).toBe(cell.id);

    const inDb = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(inDb?.currentRouteStepIndex).toBe(0);
    expect(inDb?.currentOperationId).toBe(seed.operations.CUT_DIVISION.id);
    expect(inDb?.currentEmployeeId).toBeNull();
    expect(inDb?.currentCellId).toBe(cell.id);
    expect(inDb?.status).toBe('IN_PROGRESS');

    const wipBalance = await t.prisma.workInProgressBalance.findFirst({
      where: { cellId: cell.id, sizeId: seed.sizes.M },
    });
    expect(wipBalance?.qty).toBe(8);

    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toBe('MASTER_PASSPORT_ROUTE_STEP_SET');
    const payload = audits[0]!.payload as {
      direction?: string;
      requiredCellPlacement?: boolean;
      cellId?: string;
      before: { currentRouteStepIndex: number | null };
      after: { currentRouteStepIndex: number | null };
    };
    expect(payload.direction).toBe('BACKWARD');
    expect(payload.requiredCellPlacement).toBe(true);
    expect(payload.cellId).toBe(cell.id);
    expect(payload.before.currentRouteStepIndex).toBe(2);
    expect(payload.after.currentRouteStepIndex).toBe(0);
  });

  test('set-route-step backward с employee: «из рук в руки», без ячейки и без WIP', async () => {
    // Сценарий из жизни: паспорт ушёл на ВТО (idx=2), там заметили
    // брак, ВТО физически отдаёт паспорт ОТК (idx=3 в нашем seed
    // нет — берём idx=0 как любой более ранний шаг для backward).
    // Мастер сканирует QR сотрудника-получателя → паспорт сразу
    // садится на него, минуя ячейку. WIP-баланс не двигается
    // (физически паспорт у человека, в ячейках его нет).
    const target = await t.prisma.employee.create({
      data: {
        login: 'qc-target',
        fullName: 'QC Target',
        role: 'SEAMSTRESS',
        active: true,
        pinHash: '$2a$04$abcdefghijklmnopqrstuv',
      },
    });
    const { passportId } = await setupPassport({
      qtyCut: 5,
      currentRouteStepIndex: 2,
      currentOperationCode: 'SEW_OVERLOCK_2',
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({
        reason: 'ROUTE_CORRECTION',
        routeStepIndex: 0,
        employeeQr: `EMPLOYEE:${target.id}`,
      })
      .expect(201);

    expect(res.body.passport.currentRouteStepIndex).toBe(0);
    expect(res.body.passport.currentOperation?.id).toBe(
      seed.operations.CUT_DIVISION.id,
    );
    expect(res.body.passport.currentEmployeeId).toBe(target.id);
    expect(res.body.passport.currentCell).toBeNull();

    const inDb = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(inDb?.currentRouteStepIndex).toBe(0);
    expect(inDb?.currentEmployeeId).toBe(target.id);
    expect(inDb?.currentCellId).toBeNull();
    expect(inDb?.status).toBe('IN_PROGRESS');

    // WIP не трогается на backward+employee — паспорт не в ячейке.
    const wipBalance = await t.prisma.workInProgressBalance.findFirst({
      where: { sizeId: seed.sizes.M },
    });
    expect(wipBalance).toBeNull();

    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toBe('MASTER_PASSPORT_ROUTE_STEP_SET');
    const payload = audits[0]!.payload as {
      direction?: string;
      placement?: string;
      requiredCellPlacement?: boolean;
      cellId?: string;
      targetEmployeeId?: string;
    };
    expect(payload.direction).toBe('BACKWARD');
    expect(payload.placement).toBe('EMPLOYEE');
    // requiredCellPlacement пишется только если placement = CELL —
    // auditPayload не сериализует falsy значения. На backward+employee
    // это поле должно отсутствовать.
    expect(payload.requiredCellPlacement).toBeUndefined();
    expect(payload.cellId).toBeUndefined();
    expect(payload.targetEmployeeId).toBe(target.id);
  });

  test('set-route-step backward+employee на завершённый шаг: переоткрывает гейт и садит на сотрудника', async () => {
    // Семантика как в продакшен-кейсе «ОТК выпустил, ВТО нашёл брак»,
    // но в seed-маршруте QC стоит ПОСЛЕ всех SEW, поэтому моделируем
    // эквивалент на SEW-шагах: паспорт на QC (idx=3), на
    // SEW_OVERLOCK_2 (idx=2) уже OPERATION_FINISHED, мастер
    // возвращает на SEW_OVERLOCK_2 к новому сотруднику. Это то же
    // backward на завершённую операцию — проверяем механику:
    //   1) 201, паспорт на target у target-сотрудника,
    //   2) автоматически записан OPERATION_REWORK_OPENED на target,
    //   3) audit содержит reopenedFinishedTarget + previousFinisherEmployeeId.
    const previousFinisher = seed.employees.seamstress;
    const target = await t.prisma.employee.create({
      data: {
        login: 'recheck-target',
        fullName: 'Перепроверяющий',
        role: 'SEAMSTRESS',
        active: true,
        pinHash: '$2a$04$abcdefghijklmnopqrstuv',
      },
    });
    const { passportId } = await setupPassport({
      qtyCut: 6,
      currentRouteStepIndex: 3,
      currentOperationCode: 'QC',
    });
    // OPERATION_FINISHED на SEW_OVERLOCK_2 (idx=2) — операция, на
    // которую возвращаем.
    await t.prisma.passportEvent.create({
      data: {
        passportId,
        type: 'OPERATION_FINISHED',
        operationId: seed.operations.SEW_OVERLOCK_2.id,
        employeeId: previousFinisher.id,
        qty: 6,
      },
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({
        reason: 'ROUTE_CORRECTION',
        comment: 'нашли брак после выпуска',
        routeStepIndex: 2,
        employeeQr: `EMPLOYEE:${target.id}`,
      })
      .expect(201);

    expect(res.body.passport.currentRouteStepIndex).toBe(2);
    expect(res.body.passport.currentOperation?.id).toBe(
      seed.operations.SEW_OVERLOCK_2.id,
    );
    expect(res.body.passport.currentEmployeeId).toBe(target.id);
    expect(res.body.passport.currentCell).toBeNull();
    expect(res.body.passport.status).toBe('IN_PROGRESS');

    // OPERATION_REWORK_OPENED на target — гейт переоткрыт. employeeId
    // события — previous финишёр (нужно для секции «К переделке» в UI
    // и последующего revoke pending при настоящей переделке).
    const rework = await t.prisma.passportEvent.findMany({
      where: {
        passportId,
        type: 'OPERATION_REWORK_OPENED',
        operationId: seed.operations.SEW_OVERLOCK_2.id,
      },
    });
    expect(rework).toHaveLength(1);
    expect(rework[0]!.employeeId).toBe(previousFinisher.id);
    expect(rework[0]!.qty).toBe(6);

    // Audit-payload подсвечивает re-open.
    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toBe('MASTER_PASSPORT_ROUTE_STEP_SET');
    const payload = audits[0]!.payload as {
      direction?: string;
      placement?: string;
      reopenedFinishedTarget?: boolean;
      previousFinisherEmployeeId?: string;
      targetEmployeeId?: string;
    };
    expect(payload.direction).toBe('BACKWARD');
    expect(payload.placement).toBe('EMPLOYEE');
    expect(payload.reopenedFinishedTarget).toBe(true);
    expect(payload.previousFinisherEmployeeId).toBe(previousFinisher.id);
    expect(payload.targetEmployeeId).toBe(target.id);
  });

  test('set-route-step FORWARD на завершённую op остаётся заблокирован 409', async () => {
    // Контр-кейс к переоткрытию: forward (same-idx тоже считается
    // не-backward) на завершённую операцию — блок сохраняется. Мастер
    // не должен иметь возможность «пройти» по уже закрытой операции
    // повторно вперёд: это противоречит инварианту «оплата за изделие
    // — один раз».
    const { passportId } = await setupPassport({
      currentRouteStepIndex: 1,
      currentOperationCode: 'SEW_OVERLOCK_1',
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId,
        type: 'OPERATION_FINISHED',
        operationId: seed.operations.SEW_OVERLOCK_2.id,
        employeeId: seed.employees.seamstress.id,
        qty: 5,
      },
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({ reason: 'ROUTE_CORRECTION', routeStepIndex: 2 })
      .expect(409);
    expect(res.body?.code).toBe('MASTER_TARGET_OPERATION_ALREADY_FINISHED');

    // OPERATION_REWORK_OPENED НЕ должен появиться — мы не давали
    // переоткрывать на forward.
    const rework = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'OPERATION_REWORK_OPENED' },
    });
    expect(rework).toHaveLength(0);
  });

  test('set-route-step backward с employee: target деактивирован → 409 TARGET_EMPLOYEE_INACTIVE', async () => {
    const target = await t.prisma.employee.create({
      data: {
        login: 'qc-inactive',
        fullName: 'QC Inactive',
        role: 'SEAMSTRESS',
        active: false,
        pinHash: '$2a$04$abcdefghijklmnopqrstuv',
      },
    });
    const { passportId } = await setupPassport({
      currentRouteStepIndex: 2,
      currentOperationCode: 'SEW_OVERLOCK_2',
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({
        reason: 'ROUTE_CORRECTION',
        routeStepIndex: 0,
        employeeId: target.id,
      })
      .expect(409);
    expect(res.body?.code).toBe('TARGET_EMPLOYEE_INACTIVE');

    // Состояние не поменялось — проверка до транзакции.
    const inDb = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(inDb?.currentRouteStepIndex).toBe(2);
  });

  test('set-route-step forward с placement не обязателен (FORWARD-направление)', async () => {
    // Контр-кейс: forward (idx 1 → 2) обязан работать без cellId,
    // как и раньше. Это страхует, что мы не сломали happy-path.
    const { passportId } = await setupPassport({
      currentRouteStepIndex: 1,
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({ reason: 'ROUTE_CORRECTION', routeStepIndex: 2 })
      .expect(201);

    expect(res.body.passport.currentCell).toBeNull();
    expect(res.body.passport.currentEmployeeId).toBeNull();

    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId },
    });
    const payload = audits[0]!.payload as {
      direction?: string;
      requiredCellPlacement?: boolean;
    };
    expect(payload.direction).toBe('FORWARD');
    expect(payload.requiredCellPlacement).toBeUndefined();
  });

  test('set-route-step: у заказа нет snapshot → 409 ORDER_HAS_NO_ROUTE_SNAPSHOT', async () => {
    const { passportId } = await setupPassport({
      withRouteSnapshot: false,
      currentRouteStepIndex: null,
      currentOperationCode: 'SEW_OVERLOCK_1',
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({ reason: 'ROUTE_CORRECTION', routeStepIndex: 0 })
      .expect(409);
    expect(res.body?.code).toBe('ORDER_HAS_NO_ROUTE_SNAPSHOT');
  });

  // -------------------------------------------------------------------------
  // 5. SAFETY: reason required, RBAC, terminal status
  // -------------------------------------------------------------------------

  test('reason required: пустой body → 400 VALIDATION_ERROR', async () => {
    const { passportId } = await setupPassport();

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/unassign`)
      .set('Cookie', cookies.master)
      .send({})
      .expect(400);
    expect(res.body?.code).toBe('VALIDATION_ERROR');
  });

  test('non-master forbidden: SEAMSTRESS → 403 FORBIDDEN_ROLE', async () => {
    const { passportId } = await setupPassport();

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/unassign`)
      .set('Cookie', cookies.seamstress)
      .send({ reason: 'WRONG_SCAN' })
      .expect(403);
    expect(res.body?.code).toBe('FORBIDDEN_ROLE');
  });

  test('PACKED passport не меняется → 409 PASSPORT_TERMINAL', async () => {
    const { passportId } = await setupPassport({
      status: 'PACKED',
      currentEmployeeId: null,
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/unassign`)
      .set('Cookie', cookies.master)
      .send({ reason: 'WRONG_SCAN' })
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_TERMINAL');
  });

  test('CANCELLED passport не меняется → 409 PASSPORT_TERMINAL', async () => {
    const { passportId } = await setupPassport({
      status: 'CANCELLED',
      currentEmployeeId: null,
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/return-to-cell`)
      .set('Cookie', cookies.master)
      .send({ reason: 'CELL_CORRECTION', cellId: seed.cells.A1.id })
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_TERMINAL');
  });
});
