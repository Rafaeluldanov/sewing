/**
 * Integration-тест: рабочий контур ОТК (`/qc`) требует активной смены
 * на оборудовании с операцией категории `QC`.
 *
 * Контракт со scan-driven терминалом (`apps/web/app/qc/qc-terminal.tsx`)
 * — frontend подтягивает `getCurrentShift` и решает, показывать ли
 * `SeamstressShiftStart` или scan-flow. Backend остаётся источником
 * истины: `lookupQcPassportAction` всегда зовёт общий
 * `POST /api/passports/:id/scan`, который требует
 * `SHIFT_SESSION_REQUIRED` — иначе scan не пройдёт даже если SSR
 * увидел смену (она могла истечь между SSR и POST).
 *
 * Покрываем три инварианта (см. `docs/flows.md §F5`,
 * `docs/screens.md §5.1`):
 *
 *   1. Без активной смены `POST /api/passports/:id/scan` от имени QC
 *      возвращает `SHIFT_SESSION_REQUIRED` — frontend-gate можно
 *      обойти, но backend остаётся в безопасности.
 *   2. После старта смены на `qc-station-01` (allow-лист = {QC})
 *      сотрудник QC может скан-нуть паспорт и получить QC-карточку;
 *      `passport.currentOperationId` переключается на операцию
 *      категории `QC` (нужно для shopfloor-проекции, см. F11).
 *   3. После `complete` — `qcCompletedAt` заполняется, статус не
 *      двигается. Регрессия от прежнего сьюта тоже проверяется
 *      `production-flow.test.ts §D2`; здесь дополнительно фиксируем,
 *      что путь работает именно от лица QC-смены.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — QC shift-gated scan flow', () => {
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

  /**
   * Подготовить «живой» паспорт в `IN_PROGRESS` так же, как это
   * делает `production-flow.test.ts §D2` — через начатую смену
   * швеи + `issue`. Возвращаем passportId.
   *
   * Опциональный `qtyCut` нужен для расширенных тестов
   * `recordDefect`: дефолт 1 сохраняет существующие сценарии без
   * изменений, новые тесты могут попросить большую партию.
   */
  async function prepareInProgressPassport(
    opts: { qtyCut?: number } = {},
  ): Promise<string> {
    const qtyCut = opts.qtyCut ?? 1;
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: qtyCut }],
      })
      .expect(201);
    const orderId: string = order.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-QC-01',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passport.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);
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
    return passportId;
  }

  /**
   * Открыть QC-смену и провести scan-in паспорта на QC. Возвращает
   * passportId, готовый к `recordDefect` / `completeQc`.
   */
  async function prepareQcReady(opts: { qtyCut?: number } = {}): Promise<string> {
    const passportId = await prepareInProgressPassport(opts);
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
    return passportId;
  }

  test('Без активной смены QC-сотрудник не может scan-нуть паспорт (SHIFT_SESSION_REQUIRED)', async () => {
    const passportId = await prepareInProgressPassport();

    // GET QC-карточки доступен по RBAC (его UI использует для refresh-а
    // карточки), но `scan` обязателен для входа в работу — без него
    // shopfloor-проекция не подвинет паспорт в bucket QC.
    const scan = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(scan.status).toBe(409);
    expect(scan.body.code).toBe('SHIFT_SESSION_REQUIRED');
  });

  test('После старта смены на qc-station QC-сотрудник может scan-нуть паспорт и получить QC-карточку', async () => {
    const passportId = await prepareInProgressPassport();

    // Имитируем то, что делает SeamstressShiftStart на /qc: QR
    // оборудования → выбор операции из allow-листа → POST /shifts/start.
    const start = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      });
    expect(start.status).toBe(201);
    expect(start.body.active).toBe(true);

    // А теперь scan от лица QC должен пройти и переключить
    // `currentOperationId` на операцию категории QC — это нужно
    // shopfloor-проекции (см. flows.md §F11). DTO ответа не отдаёт
    // `currentOperationId` (см. PassportDetailDto в
    // packages/shared/src/passports.ts), поэтому факт переключения
    // проверяем напрямую по БД — это и есть инвариант, на который
    // дальше опирается shopfloor-bucket «QC».
    const scan = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(scan.status).toBe(201);
    const afterScan = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: { currentOperationId: true, currentEmployeeId: true },
    });
    expect(afterScan.currentOperationId).toBe(seed.operations.QC.id);
    expect(afterScan.currentEmployeeId).toBe(seed.employees['qc'].id);

    const detail = await request(t.app.getHttpServer())
      .get(`/api/qc/passports/${passportId}`)
      .set('Cookie', cookies.qc)
      .expect(200);
    expect(detail.body.canCompleteQc).toBe(true);
    expect(detail.body.qcCompletedAt).toBeNull();

    // «Проверка выполнена» — пишет QC_PASSED, статус не трогает
    // (см. flows.md §F5, transaction `QcService.completeQc`).
    const complete = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    expect(typeof complete.body.qcCompletedAt).toBe('string');
    expect(complete.body.status).toBe('IN_PROGRESS');
  });

  test('GET /api/shifts/meta для QC возвращает qc-station с allow-листом {QC} — start-shift форма получает то же, что у швеи', async () => {
    // Проверяем backend-side контракт, на который опирается
    // `SeamstressShiftStart` на /qc: оборудование `qc-station-01`
    // отдаётся активным с `allowedOperationIds`, содержащим операцию
    // категории QC. Без этого UI не построил бы список «доступные
    // операции» для QC-смены.
    const meta = await request(t.app.getHttpServer())
      .get('/api/shifts/meta')
      .set('Cookie', cookies.qc)
      .expect(200);

    const qcStation = (meta.body.equipment as Array<{
      code: string;
      active: boolean;
      allowedOperationIds: string[];
    }>).find((e) => e.code === 'qc-station-01');
    expect(qcStation, 'qc-station-01 must be present in meta').toBeDefined();
    expect(qcStation!.active).toBe(true);
    expect(qcStation!.allowedOperationIds).toContain(seed.operations.QC.id);
  });

  // ---------------------------------------------------------------------------
  // P0-5: дополнительные QC-инварианты (см. docs/test-gap-plan.md §P0-5).
  // ---------------------------------------------------------------------------

  /**
   * Row-level идемпотентность `completeQc` (см. recon §6 invariant 6,
   * fixed в `QcService.completeQc`): второй клик возвращает успешный
   * detail, но НЕ пишет ни второй `PassportEvent(QC_PASSED)`, ни
   * вторую запись `AuditLog(QC_COMPLETED)`, ни не сдвигает
   * `qcCompletedAt`.
   */
  test('completeQc × 2 идемпотентен: один QC_PASSED, один QC_COMPLETED, qcCompletedAt стабилен', async () => {
    const passportId = await prepareQcReady();

    const first = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(first.status).toBe(201);
    const firstQcAt = first.body.qcCompletedAt as string;
    expect(typeof firstQcAt).toBe('string');

    // Небольшая пауза — если бы сервис писал второй event, у него
    // был бы наблюдаемо более поздний timestamp.
    await new Promise((r) => setTimeout(r, 5));

    const second = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(second.status).toBe(201);
    const secondQcAt = second.body.qcCompletedAt as string;
    // qcCompletedAt не сдвигается — это тот же первый event.
    expect(secondQcAt).toBe(firstQcAt);

    // Row-level контракт: ровно одно событие и одна запись в AuditLog.
    const passportEvents = await t.prisma.passportEvent.count({
      where: { passportId, type: 'QC_PASSED' },
    });
    expect(passportEvents).toBe(1);
    const auditCount = await t.prisma.auditLog.count({
      where: { event: 'QC_COMPLETED', entityType: 'QC', entityId: passportId },
    });
    expect(auditCount).toBe(1);

    // Status паспорта остаётся IN_PROGRESS — completeQc сознательно
    // не двигает pipeline (см. service.ts JSDoc).
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: { status: true },
    });
    expect(passport.status).toBe('IN_PROGRESS');
  });

  /**
   * Регрессия инцидента 10.08.2026 (`P-20260804-0007`, заказ 02-00003).
   *
   * Приняв паспорт сканом, ОТК становится его `currentEmployeeId`.
   * «Проверка выполнена» раньше писала только `QC_PASSED` и строку
   * паспорта не трогала — годный паспорт навсегда оставался «в работе»
   * у контролёра, и следующий исполнитель получал на «Взять крой» 409
   * `PASSPORT_ALREADY_ISSUED` (см. ветку route-WIP без ячейки в
   * `PassportsService.issueToEmployee`), а сам контролёр не мог
   * переключить смену (`SHIFT_HAS_ACTIVE_PASSPORTS`). Брак паспорт
   * освобождал (`returnToRework`), годный — нет.
   *
   * Контракт: `completeQc` снимает ТОЛЬКО владельца. Операция, шаг
   * маршрута и статус остаются на месте — это не движение по маршруту,
   * а то же освобождение, что делает мастер (`unassign`).
   */
  test('completeQc снимает паспорт с ОТК: currentEmployeeId=null, операция и шаг маршрута не тронуты', async () => {
    const passportId = await prepareQcReady();

    const before = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: {
        currentEmployeeId: true,
        currentOperationId: true,
        currentRouteStepIndex: true,
      },
    });
    // Precondition: после scan-in паспорт числится за ОТК.
    expect(before.currentEmployeeId).toBe(seed.employees['qc'].id);
    expect(before.currentOperationId).toBe(seed.operations.QC.id);

    await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);

    const after = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: {
        currentEmployeeId: true,
        currentOperationId: true,
        currentRouteStepIndex: true,
        status: true,
      },
    });
    expect(after.currentEmployeeId).toBeNull();
    expect(after.currentOperationId).toBe(before.currentOperationId);
    expect(after.currentRouteStepIndex).toBe(before.currentRouteStepIndex);
    expect(after.status).toBe('IN_PROGRESS');
  });

  /**
   * Освобождение владельца стоит ДО идемпотентного `return` в
   * `completeQc` намеренно: повтор «Проверка выполнена» по уже
   * проверенному паспорту событий не пишет, но висящего владельца
   * снимает. Это чинит накопленный бэклог руками самой ОТК, без
   * обращения к мастеру.
   */
  test('повторный completeQc снимает висящего владельца, не создавая второго QC_PASSED', async () => {
    const passportId = await prepareQcReady();
    await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);

    // Воспроизводим состояние продового бэклога: паспорт проверен, но
    // владелец на нём висит (так выглядели 67 паспортов на 10.08.2026).
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { currentEmployeeId: seed.employees['qc'].id },
    });

    await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);

    const after = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: { currentEmployeeId: true },
    });
    expect(after.currentEmployeeId).toBeNull();
    // Идемпотентность не сломана: второго события не появилось.
    const events = await t.prisma.passportEvent.count({
      where: { passportId, type: 'QC_PASSED' },
    });
    expect(events).toBe(1);
  });

  /**
   * Обратная сторона того же контракта: снимаем владельца, только если
   * паспорт ФИЗИЧЕСКИ стоит на ОТК. Контролёр может нажать «Проверка
   * выполнена» и по паспорту, который числится за швеёй (её операция
   * ещё не закрыта) — вот её владельца трогать нельзя, иначе ОТК
   * снимала бы швею с незакрытой работы.
   */
  test('completeQc не трогает владельца, если паспорт числится за швеёй на швейной операции', async () => {
    // Без scan-in на ОТК: паспорт выдан швее и стоит на её операции.
    const passportId = await prepareInProgressPassport();
    const before = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: { currentEmployeeId: true, currentOperationId: true },
    });
    expect(before.currentEmployeeId).toBe(seed.employees['seamstress'].id);

    await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);

    const after = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: { currentEmployeeId: true, currentOperationId: true },
    });
    expect(after.currentEmployeeId).toBe(seed.employees['seamstress'].id);
    expect(after.currentOperationId).toBe(before.currentOperationId);
  });

  test('recordDefect happy path: qtyGood=8, qtyDefect=2, sum ≤ qtyCut', async () => {
    const passportId = await prepareQcReady({ qtyCut: 10 });
    const before = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: { qtyCut: true, qtyGood: true, qtyDefect: true },
    });
    expect(before).toMatchObject({ qtyCut: 10, qtyGood: 10, qtyDefect: 0 });

    const res = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/defects`)
      .set('Cookie', cookies.qc)
      .send({ defectTypeId: seed.defectType.id, qty: 2 });
    expect(res.status).toBe(201);

    const after = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: { qtyCut: true, qtyGood: true, qtyDefect: true },
    });
    expect(after).toMatchObject({ qtyCut: 10, qtyGood: 8, qtyDefect: 2 });
    expect(after.qtyGood + after.qtyDefect).toBeLessThanOrEqual(after.qtyCut);

    const defects = await t.prisma.passportDefect.findMany({
      where: { passportId },
    });
    expect(defects).toHaveLength(1);
    expect(defects[0]!.qty).toBe(2);

    const events = await t.prisma.passportEvent.count({
      where: { passportId, type: 'DEFECT_RECORDED' },
    });
    expect(events).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // recordDefect → авто-пересчёт сдельных OperationEntry до нового qtyGood.
  // Правило цеха: финальная сдельная выработка по паспорту = qtyGood для
  // ВСЕХ сдельных сотрудников (см. JSDoc `EarningsService.reconcileToQtyGood`).
  // OperationEntry создаётся снапшотом при `OPERATION_FINISHED`; до фикса
  // дефект, найденный после завершения операции, оставлял у швеи устаревший
  // qty/amount, и она получала за брак как за годное.
  // ---------------------------------------------------------------------------

  test('recordDefect авто-пересчитывает сдельные OperationEntry до нового qtyGood, cutter не тронут', async () => {
    const passportId = await prepareQcReady({ qtyCut: 10 });
    // Симулируем, что швея и ВТО уже закрыли операции — у них есть
    // APPROVED OperationEntry со снимком qty=10. Создаём напрямую, как
    // в packing-close-idempotent.test.ts §2.
    const seamstressEntry = await t.prisma.operationEntry.create({
      data: {
        passportId,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 10,
        ratePerUnit: new Prisma.Decimal(50),
        amount: new Prisma.Decimal(500),
        status: 'APPROVED',
        approvalMode: 'AFTER_RELEASE',
        sourceEventType: 'OPERATION_TRANSITION',
        approvedAt: new Date(),
      },
    });
    // Cutter-начисление (PASSPORT_CREATED) — должно остаться нетронутым:
    // раскройщик платится за qtyCut независимо от брака швеи.
    const cutterEntry = await t.prisma.operationEntry.create({
      data: {
        passportId,
        operationId: seed.operations.CUT_CUT.id,
        employeeId: seed.employees.cutter.id,
        qty: 10,
        ratePerUnit: new Prisma.Decimal(7),
        amount: new Prisma.Decimal(70),
        status: 'APPROVED',
        approvalMode: 'IMMEDIATE',
        sourceEventType: 'PASSPORT_CREATED',
        approvedAt: new Date(),
      },
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/defects`)
      .set('Cookie', cookies.qc)
      .send({ defectTypeId: seed.defectType.id, qty: 3 });
    expect(res.status).toBe(201);

    const seamstressAfter = await t.prisma.operationEntry.findUniqueOrThrow({
      where: { id: seamstressEntry.id },
    });
    expect(seamstressAfter.qty).toBe(7);
    expect(seamstressAfter.amount.toFixed(2)).toBe('350.00');

    // Cutter — не тронут, остался на исходном qty=10/amount=70.
    const cutterAfter = await t.prisma.operationEntry.findUniqueOrThrow({
      where: { id: cutterEntry.id },
    });
    expect(cutterAfter.qty).toBe(10);
    expect(cutterAfter.amount.toFixed(2)).toBe('70.00');
  });

  test('recordDefect не трогает OperationEntry, уже включённую в PayrollPayoutLine', async () => {
    const passportId = await prepareQcReady({ qtyCut: 10 });
    const paidEntry = await t.prisma.operationEntry.create({
      data: {
        passportId,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 10,
        ratePerUnit: new Prisma.Decimal(50),
        amount: new Prisma.Decimal(500),
        status: 'APPROVED',
        approvalMode: 'AFTER_RELEASE',
        sourceEventType: 'OPERATION_TRANSITION',
        approvedAt: new Date(),
      },
    });
    // Симулируем, что этот entry уже выплачен — есть PayrollPayoutLine.
    const payout = await t.prisma.payrollPayout.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        periodFrom: new Date('2026-04-01'),
        periodTo: new Date('2026-04-30'),
        status: 'ISSUED',
        amountPieceworkRub: new Prisma.Decimal(500),
        amountSalaryRub: new Prisma.Decimal(0),
        amountTotalRub: new Prisma.Decimal(500),
        createdById: seed.employees['shop-chief'].id,
        issuedAt: new Date(),
        issuedById: seed.employees['shop-chief'].id,
      },
    });
    await t.prisma.payrollPayoutLine.create({
      data: {
        payoutId: payout.id,
        kind: 'PIECEWORK',
        operationEntryId: paidEntry.id,
        amountRub: new Prisma.Decimal(500),
        occurredOn: new Date('2026-04-15'),
        snapshot: { qty: 10, ratePerUnit: 50 },
      },
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/defects`)
      .set('Cookie', cookies.qc)
      .send({ defectTypeId: seed.defectType.id, qty: 3 });
    expect(res.status).toBe(201);

    // Дефект всё равно зафиксирован — qtyGood=7.
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: { qtyGood: true, qtyDefect: true },
    });
    expect(passport).toMatchObject({ qtyGood: 7, qtyDefect: 3 });

    // А вот выплаченную строку — не трогаем.
    const paidAfter = await t.prisma.operationEntry.findUniqueOrThrow({
      where: { id: paidEntry.id },
    });
    expect(paidAfter.qty).toBe(10);
    expect(paidAfter.amount.toFixed(2)).toBe('500.00');
  });

  test('recordDefect overflow → 422 DEFECT_EXCEEDS_REMAINING, без сайд-эффектов', async () => {
    // Готовим состояние qtyCut=10, qtyDefect=9, qtyGood=1 через нормальный
    // flow, без прямого изменения БД.
    const passportId = await prepareQcReady({ qtyCut: 10 });
    await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/defects`)
      .set('Cookie', cookies.qc)
      .send({ defectTypeId: seed.defectType.id, qty: 9 })
      .expect(201);

    const before = await snapshotForDefectAttempt(passportId);
    expect(before.qtyGood).toBe(1);
    expect(before.qtyDefect).toBe(9);
    expect(before.defectsCount).toBe(1);
    expect(before.defectEventsCount).toBe(1);

    // qty=2 > remaining (qtyCut - qtyDefect = 1) → 422.
    const res = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/defects`)
      .set('Cookie', cookies.qc)
      .send({ defectTypeId: seed.defectType.id, qty: 2 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DEFECT_EXCEEDS_REMAINING');

    // Снимок не изменился: counts и qty стабильны.
    const after = await snapshotForDefectAttempt(passportId);
    expect(after).toEqual(before);
    expect(after.qtyGood + after.qtyDefect).toBeLessThanOrEqual(after.qtyCut);
  });

  /**
   * Снимок именно того, что обязан сохраниться при отказе recordDefect:
   * счётчики паспорта, count `PassportDefect`, count `PassportEvent
   * DEFECT_RECORDED` и count `AuditLog` по дефектам.
   */
  async function snapshotForDefectAttempt(passportId: string) {
    const [p, defects, events, audit] = await Promise.all([
      t.prisma.passport.findUniqueOrThrow({
        where: { id: passportId },
        select: { qtyCut: true, qtyGood: true, qtyDefect: true },
      }),
      t.prisma.passportDefect.count({ where: { passportId } }),
      t.prisma.passportEvent.count({
        where: { passportId, type: 'DEFECT_RECORDED' },
      }),
      // Audit-канал по дефектам в текущем коде QC-сервис явно НЕ
      // пишет (см. recordDefect — нет audit.log). Считаем для полноты
      // картины — должен оставаться 0.
      t.prisma.auditLog.count({
        where: { entityType: 'QC', entityId: passportId, event: 'DEFECT_RECORDED' },
      }),
    ]);
    return {
      qtyCut: p.qtyCut,
      qtyGood: p.qtyGood,
      qtyDefect: p.qtyDefect,
      defectsCount: defects,
      defectEventsCount: events,
      defectAuditCount: audit,
    };
  }

  // ---------------------------------------------------------------------------
  // Retroactive QC для PACKED-паспортов (исторический бэклог, упакованных
  // до route-gate в `PackingService.addPassport`). Сервис разрешает
  // ровно одну запись `QC_PASSED` для status==PACKED, чтобы оператор
  // мог дозаписать ОТК через UI «Проверка выполнена».
  // ---------------------------------------------------------------------------

  test('completeQc на PACKED без QC_PASSED → 201, пишет QC_PASSED один раз; повторно → PASSPORT_NOT_QCABLE', async () => {
    const passportId = await prepareInProgressPassport();
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { status: 'PACKED', currentEmployeeId: null, currentCellId: null },
    });

    const first = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(first.status).toBe(201);
    expect(typeof first.body.qcCompletedAt).toBe('string');
    expect(first.body.status).toBe('PACKED');

    const qcEvents = await t.prisma.passportEvent.count({
      where: { passportId, type: 'QC_PASSED' },
    });
    expect(qcEvents).toBe(1);

    // Повторный вызов после успешного retroactive — заворачиваем как
    // «уже сделано» (PASSPORT_NOT_QCABLE), второй event не пишется.
    const second = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PASSPORT_NOT_QCABLE');

    const qcEventsAfter = await t.prisma.passportEvent.count({
      where: { passportId, type: 'QC_PASSED' },
    });
    expect(qcEventsAfter).toBe(1);
  });

  test('QC detail карточка для PACKED без QC_PASSED показывает canCompleteQc=true', async () => {
    const passportId = await prepareInProgressPassport();
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { status: 'PACKED', currentEmployeeId: null, currentCellId: null },
    });

    const detail = await request(t.app.getHttpServer())
      .get(`/api/qc/passports/${passportId}`)
      .set('Cookie', cookies.qc)
      .expect(200);
    expect(detail.body.canCompleteQc).toBe(true);
    expect(detail.body.qcCompletedAt).toBeNull();
  });
});
