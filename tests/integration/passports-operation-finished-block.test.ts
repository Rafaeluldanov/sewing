/**
 * Integration-тесты бизнес-правила «операция по паспорту, у которой
 * уже есть `OPERATION_FINISHED`, считается закрытой безвозвратно»
 * (с одним исключением для мастера, см. C).
 *
 * Покрываем:
 *   A. `POST /api/passports/:id/issue` → 409 `PASSPORT_OPERATION_ALREADY_FINISHED`,
 *      когда у паспорта уже есть `OPERATION_FINISHED` на операции
 *      активной смены сотрудника.
 *   B. `POST /api/passports/:id/complete-operation` → тот же 409
 *      `PASSPORT_OPERATION_ALREADY_FINISHED` (defense-in-depth: обычно
 *      сюда не дойти, так как issue уже заблокирован, но прямой вызов
 *      по «застрявшему» state должен падать).
 *   C. `POST /api/master-actions/passports/:id/set-route-step`:
 *      - **backward** на завершённую операцию (типовой кейс «ВТО нашёл
 *        брак после выпуска ОТК») разрешён и автоматически переоткрывает
 *        гейт (`OPERATION_REWORK_OPENED` на target);
 *      - **forward / same-idx** на завершённую остаются заблокированы
 *        `MASTER_TARGET_OPERATION_ALREADY_FINISHED` — повторно «пройти»
 *        вперёд по уже закрытой операции мастер не может.
 *
 * Фон: см. инцидент 09.05.2026 (тех. долг — 60+ дубль-выдач у трёх швей
 * на ОВР/ФУЛ; данные расчищены вручную, защита введена этой задачей).
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

describeWithDb('integration — passports.operation-finished block', () => {
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
      master: loginAs(t, seed.employees['master']),
    };
  });

  /**
   * Создаёт заказ + snapshot маршрута CUT_DIVISION (0) → SEW_OVERLOCK_1
   * (1) → SEW_OVERLOCK_2 (2) → QC (3), плюс один паспорт в указанном
   * состоянии. Маршрут совпадает со `passports-complete-operation.test.ts`
   * и `master-actions.test.ts`, чтобы тесты читались одной семьёй.
   */
  async function setup(opts: {
    /** Начальная операция паспорта. По умолчанию `SEW_OVERLOCK_1`. */
    currentOperationCode?:
      | 'CUT_DIVISION'
      | 'SEW_OVERLOCK_1'
      | 'SEW_OVERLOCK_2';
    /** routeStepIndex паспорта. По умолчанию совпадает с операцией. */
    currentRouteStepIndex?: number;
    /** Операция активной смены. По умолчанию `SEW_OVERLOCK_1`. */
    shiftOperationCode?: 'SEW_OVERLOCK_1' | 'SEW_OVERLOCK_2';
    /** Если true — паспорт закрепляется за швеёй (для complete). */
    issueToSeamstress?: boolean;
    /** Если true — паспорт лежит в ячейке A1 (для issue из буфера). */
    placeInCell?: boolean;
    /** Какие операции уже зафиксированы как OPERATION_FINISHED. */
    finishedOps?: Array<'SEW_OVERLOCK_1' | 'SEW_OVERLOCK_2'>;
  }): Promise<{ passportId: string; orderId: string }> {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: `O-OFB-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 4 },
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

    // Активная смена швеи на overlock-01 (он allows и SEW_OVERLOCK_1, и
    // SEW_OVERLOCK_2 по seed, см. EQUIPMENT_SEEDS.allowedOperationCodes).
    const shiftOpCode = opts.shiftOperationCode ?? 'SEW_OVERLOCK_1';
    const shiftOpId = seed.operations[shiftOpCode].id;
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: shiftOpId,
        startedAt: today,
      },
    });

    const opCode = opts.currentOperationCode ?? 'SEW_OVERLOCK_1';
    const currentRouteStepIndex =
      opts.currentRouteStepIndex ??
      (opCode === 'CUT_DIVISION' ? 0 : opCode === 'SEW_OVERLOCK_1' ? 1 : 2);

    const passport = await t.prisma.passport.create({
      data: {
        number: `P-OFB-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:ofb-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-OFB',
        cutDate: today,
        qtyPlan: 4,
        qtyCut: 4,
        qtyGood: 4,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations[opCode].id,
        currentRouteStepIndex,
        currentEmployeeId: opts.issueToSeamstress
          ? seed.employees.seamstress.id
          : null,
        currentCellId: opts.placeInCell ? seed.cells.A1.id : null,
      },
    });

    for (const opKey of opts.finishedOps ?? []) {
      await t.prisma.passportEvent.create({
        data: {
          passportId: passport.id,
          type: 'OPERATION_FINISHED',
          operationId: seed.operations[opKey].id,
          employeeId: seed.employees.seamstress.id,
          qty: 4,
        },
      });
    }

    return { passportId: passport.id, orderId: order.id };
  }

  // ---------------------------------------------------------------------------
  // A. issue блокируется, если OPERATION_FINISHED уже есть
  // ---------------------------------------------------------------------------

  test('A. issue: повторный скан на завершённой операции → 409 PASSPORT_OPERATION_ALREADY_FINISHED', async () => {
    const { passportId } = await setup({
      currentOperationCode: 'SEW_OVERLOCK_1',
      currentRouteStepIndex: 1,
      shiftOperationCode: 'SEW_OVERLOCK_1',
      placeInCell: true,
      finishedOps: ['SEW_OVERLOCK_1'],
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_OPERATION_ALREADY_FINISHED');
    expect(res.body?.message).toBe(
      'Операция по данному паспорту закрыта для вас.',
    );

    // Состояние паспорта не должно поменяться: остался в ячейке,
    // currentEmployeeId не выставился, нового ISSUED_TO_EMPLOYEE-события
    // не появилось.
    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.currentEmployeeId).toBeNull();
    expect(inDb.currentCellId).toBe(seed.cells.A1.id);

    const issueEvents = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'ISSUED_TO_EMPLOYEE' },
    });
    expect(issueEvents).toHaveLength(0);
  });

  test('A-бис. issue: на чистой операции (без OPERATION_FINISHED) проходит штатно', async () => {
    // Контр-кейс: убеждаемся, что мы не сломали happy-path. Берём
    // route-WIP без ячейки (`placeInCell: false`), чтобы не дёргать
    // `WorkInProgressService.recordIssueInTx` (он требует наличия
    // баланса в ячейке, а минимальный seed его не делает).
    const { passportId } = await setup({
      currentOperationCode: 'SEW_OVERLOCK_1',
      currentRouteStepIndex: 1,
      shiftOperationCode: 'SEW_OVERLOCK_1',
      placeInCell: false,
      finishedOps: [],
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.currentEmployeeId).toBe(seed.employees.seamstress.id);
    expect(inDb.currentCellId).toBeNull();

    const issueEvents = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'ISSUED_TO_EMPLOYEE' },
    });
    expect(issueEvents).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // B. complete блокируется, если OPERATION_FINISHED уже есть
  // ---------------------------------------------------------------------------

  test('B. complete: повторное завершение той же операции → 409 PASSPORT_OPERATION_ALREADY_FINISHED', async () => {
    // Имитируем «застрявшее» состояние: на паспорте уже есть
    // OPERATION_FINISHED для SEW_OVERLOCK_1, но кто-то (например, через
    // прямой fetch или race) держит passport.currentEmployeeId = швея.
    // Прямой вызов complete должен упасть defense-in-depth.
    const { passportId } = await setup({
      currentOperationCode: 'SEW_OVERLOCK_1',
      currentRouteStepIndex: 1,
      shiftOperationCode: 'SEW_OVERLOCK_1',
      issueToSeamstress: true,
      finishedOps: ['SEW_OVERLOCK_1'],
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_OPERATION_ALREADY_FINISHED');

    // Состояние паспорта НЕ меняется: currentEmployeeId не сбрасывается,
    // второго OPERATION_FINISHED не появляется.
    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.currentEmployeeId).toBe(seed.employees.seamstress.id);

    const finEvents = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'OPERATION_FINISHED' },
    });
    expect(finEvents).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // C. master.setRouteStep: backward переоткрывает, forward блокируется
  // ---------------------------------------------------------------------------

  test('C. master setRouteStep backward на завершённую op переоткрывает гейт (OPERATION_REWORK_OPENED)', async () => {
    // Сценарий из жизни: ОТК пропустил паспорт (OPERATION_FINISHED на
    // ОТК-шаге), ВТО нашёл брак, мастер возвращает паспорт на ОТК для
    // повторной проверки. Раньше backend отдавал 409 — паспорт
    // считался безвозвратно ушедшим. После правки мастер на backward
    // ИМЕЕТ право переоткрыть гейт: пишется OPERATION_REWORK_OPENED
    // на target операцию (employeeId = последний финишёр), паспорт
    // садится на placement. На SEW_OVERLOCK_1 как пример — семантика
    // та же.
    const cell = seed.cells.A1;
    const { passportId } = await setup({
      currentOperationCode: 'SEW_OVERLOCK_2',
      currentRouteStepIndex: 2,
      shiftOperationCode: 'SEW_OVERLOCK_2',
      finishedOps: ['SEW_OVERLOCK_1'],
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({
        reason: 'ROUTE_CORRECTION',
        routeStepIndex: 1,
        cellQr: cell.qrCode,
      })
      .expect(201);

    // Паспорт переехал на SEW_OVERLOCK_1 в указанную ячейку.
    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.currentRouteStepIndex).toBe(1);
    expect(inDb.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(inDb.currentCellId).toBe(cell.id);

    // Записан OPERATION_REWORK_OPENED — гейт переоткрыт. employeeId
    // события — швея, которая завершила target в setup().
    const reworkEvents = await t.prisma.passportEvent.findMany({
      where: {
        passportId,
        type: 'OPERATION_REWORK_OPENED',
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      },
    });
    expect(reworkEvents).toHaveLength(1);
    expect(reworkEvents[0]!.employeeId).toBe(seed.employees.seamstress.id);

    // Audit фиксирует reopenedFinishedTarget = true.
    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId },
    });
    expect(audits).toHaveLength(1);
    const payload = audits[0]!.payload as {
      reopenedFinishedTarget?: boolean;
      previousFinisherEmployeeId?: string;
      direction?: string;
    };
    expect(payload.direction).toBe('BACKWARD');
    expect(payload.reopenedFinishedTarget).toBe(true);
    expect(payload.previousFinisherEmployeeId).toBe(
      seed.employees.seamstress.id,
    );
  });

  test('C-бис. master setRouteStep forward на чистую op проходит штатно', async () => {
    // Контр-кейс: forward (idx 1 → 2), SEW_OVERLOCK_1 завершена, но
    // target — SEW_OVERLOCK_2, на которой OPERATION_FINISHED НЕТ.
    // Защита не должна срабатывать.
    const { passportId } = await setup({
      currentOperationCode: 'SEW_OVERLOCK_1',
      currentRouteStepIndex: 1,
      shiftOperationCode: 'SEW_OVERLOCK_1',
      finishedOps: ['SEW_OVERLOCK_1'],
    });

    await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({ reason: 'ROUTE_CORRECTION', routeStepIndex: 2 })
      .expect(201);

    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.currentRouteStepIndex).toBe(2);
    expect(inDb.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_2.id);
  });

  test('C-2. master setRouteStep назад на ту же завершённую op (same idx) → 409', async () => {
    // Edge-case: target.index == currentIdx (не backward, не forward),
    // но операция этой же ступени уже завершена. Защита всё равно
    // должна сработать — это «вернуть на завершённую».
    const { passportId } = await setup({
      currentOperationCode: 'SEW_OVERLOCK_1',
      currentRouteStepIndex: 1,
      shiftOperationCode: 'SEW_OVERLOCK_1',
      finishedOps: ['SEW_OVERLOCK_1'],
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({ reason: 'ROUTE_CORRECTION', routeStepIndex: 1 })
      .expect(409);
    expect(res.body?.code).toBe('MASTER_TARGET_OPERATION_ALREADY_FINISHED');
  });

  // ---------------------------------------------------------------------------
  // D. Гейт «нельзя перепрыгнуть незавершённый швейный шаг вперёд»
  //    (PASSPORT_PRECEDING_STEP_INCOMPLETE). Инцидент 16.06.2026:
  //    P-20260611-0004 взяли на КИПЕРКУ (idx 3) минуя ОВР/ФУЛ (idx 2),
  //    т.к. backward/groupIncomplete не ловят forward-skip одиночного
  //    шага. Здесь аналог: SEW_OVERLOCK_2 (idx 2) при незакрытом
  //    SEW_OVERLOCK_1 (idx 1), паспорт ещё на CUT_DIVISION (idx 0).
  // ---------------------------------------------------------------------------

  test('D. issue: пропуск незавершённого швейного шага вперёд → 409 PASSPORT_PRECEDING_STEP_INCOMPLETE', async () => {
    const { passportId } = await setup({
      currentOperationCode: 'CUT_DIVISION',
      currentRouteStepIndex: 0,
      shiftOperationCode: 'SEW_OVERLOCK_2',
      placeInCell: false,
      finishedOps: [],
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_PRECEDING_STEP_INCOMPLETE');

    // Состояние не меняется: не закрепился, нового ISSUED-события нет.
    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.currentEmployeeId).toBeNull();
    expect(inDb.currentRouteStepIndex).toBe(0);
    const issueEvents = await t.prisma.passportEvent.findMany({
      where: { passportId, type: 'ISSUED_TO_EMPLOYEE' },
    });
    expect(issueEvents).toHaveLength(0);
  });

  test('D-2. scan: тот же пропуск через /scan → 409 PASSPORT_PRECEDING_STEP_INCOMPLETE', async () => {
    const { passportId } = await setup({
      currentOperationCode: 'CUT_DIVISION',
      currentRouteStepIndex: 0,
      shiftOperationCode: 'SEW_OVERLOCK_2',
      placeInCell: false,
      finishedOps: [],
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_PRECEDING_STEP_INCOMPLETE');
  });

  test('D-3. issue: предыдущий швейный шаг завершён → переход вперёд проходит', async () => {
    // Контр-кейс: SEW_OVERLOCK_1 закрыт (OPERATION_FINISHED) → выход на
    // SEW_OVERLOCK_2 минуя «застрявший» idx разрешён.
    const { passportId } = await setup({
      currentOperationCode: 'CUT_DIVISION',
      currentRouteStepIndex: 0,
      shiftOperationCode: 'SEW_OVERLOCK_2',
      placeInCell: false,
      finishedOps: ['SEW_OVERLOCK_1'],
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_2.id);
    expect(inDb.currentRouteStepIndex).toBe(2);
  });

  test('D-4. issue: переход на НЕПОСРЕДСТВЕННО следующий швейный шаг не блокируется', async () => {
    // Happy-path: паспорт на CUT_DIVISION (idx 0), берёт первый швейный
    // шаг SEW_OVERLOCK_1 (idx 1) — между ними нет незакрытых швейных
    // шагов (крой CUTTING не считается), гейт пропускает.
    const { passportId } = await setup({
      currentOperationCode: 'CUT_DIVISION',
      currentRouteStepIndex: 0,
      shiftOperationCode: 'SEW_OVERLOCK_1',
      placeInCell: false,
      finishedOps: [],
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(inDb.currentRouteStepIndex).toBe(1);
  });
});
