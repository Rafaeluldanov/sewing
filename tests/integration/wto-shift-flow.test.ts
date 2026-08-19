/**
 * Integration-тест: рабочий контур ВТО (`/wto`) требует активной смены
 * на оборудовании с операцией категории `IRONING`.
 *
 * Контракт со scan-driven терминалом (`apps/web/app/wto/wto-terminal.tsx`)
 * — frontend подтягивает `getCurrentShift` и решает, показывать ли
 * `SeamstressShiftStart` или scan-flow. Backend остаётся источником
 * истины: `acceptOnWtoAction` всегда зовёт общий
 * `POST /api/passports/:id/scan`, который требует
 * `SHIFT_SESSION_REQUIRED` — иначе scan не пройдёт даже если SSR
 * увидел смену (она могла истечь между SSR и POST).
 *
 * Симметрично `qc-shift-flow.test.ts`, но с дополнительным WTO-чеком
 * на `PASSPORT_NOT_QC_PASSED` (см. `docs/flows.md §F6`).
 *
 * Покрываем три инварианта (см. `docs/flows.md §F6`,
 * `docs/screens.md §5a.1`):
 *
 *   1. Без активной смены `POST /api/passports/:id/scan` от имени
 *      ВТО возвращает `SHIFT_SESSION_REQUIRED` — frontend-gate можно
 *      обойти, но backend остаётся в безопасности.
 *   2. После старта смены на `ironing-station-01` (allow-лист =
 *      {IRONING}) сотрудник ВТО может скан-нуть прошедший ОТК паспорт
 *      и получить WTO-карточку; `passport.currentOperationId`
 *      переключается на операцию категории `IRONING` (нужно для
 *      shopfloor-проекции, см. F11).
 *   3. После `complete` — `wtoCompletedAt` заполняется, статус не
 *      двигается. Регрессия от прежнего сьюта тоже проверяется
 *      `production-flow.test.ts §D4c`; здесь дополнительно фиксируем,
 *      что путь работает именно от лица WTO-смены, и что
 *      `GET /api/shifts/meta` для роли IRONING отдаёт wto-station с
 *      allow-листом {IRONING} — иначе `SeamstressShiftStart` на
 *      `/wto` не построил бы список «доступные операции».
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

describeWithDb('integration — WTO shift-gated scan flow', () => {
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
      ironing: loginAs(t, seed.employees['ironing']),
    };
  });

  /**
   * Подготовить «живой» паспорт в `IN_PROGRESS` так же, как это
   * делает `production-flow.test.ts §D4`. Возвращаем passportId.
   * Если `passQc=true`, дополнительно отмечаем «Проверка выполнена»
   * (без этого WTO-вход упирается в `PASSPORT_NOT_QC_PASSED`).
   */
  async function prepareInProgressPassport(passQc: boolean): Promise<string> {
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
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
        rollNumber: 'R-WTO-01',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
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
    if (passQc) {
      // QC отмечает «Проверка выполнена» — без этого scan-in на ВТО
      // упирается в `PASSPORT_NOT_QC_PASSED` (см. F6 QC-gate).
      await request(t.app.getHttpServer())
        .post(`/api/qc/passports/${passportId}/complete`)
        .set('Cookie', cookies.qc)
        .send({})
        .expect(201);
    }
    return passportId;
  }

  test('Без активной смены WTO-сотрудник не может scan-нуть паспорт (SHIFT_SESSION_REQUIRED)', async () => {
    // QC уже подтвердил паспорт — чтобы доказать, что shift-gate
    // действительно сработал ПЕРЕД QC-gate. Иначе тест мог бы
    // случайно зелёный из-за более раннего бизнес-конфликта.
    const passportId = await prepareInProgressPassport(true);

    const scan = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.ironing)
      .send({});
    expect(scan.status).toBe(409);
    expect(scan.body.code).toBe('SHIFT_SESSION_REQUIRED');
  });

  test('После старта смены на ironing-station WTO-сотрудник может scan-нуть паспорт и получить WTO-карточку', async () => {
    const passportId = await prepareInProgressPassport(true);

    // Имитируем то, что делает SeamstressShiftStart на /wto: QR
    // оборудования → выбор операции из allow-листа → POST /shifts/start.
    const start = await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.ironing)
      .send({
        equipmentId: seed.equipment['ironing-station-01'].id,
        operationId: seed.operations.IRONING.id,
      });
    expect(start.status).toBe(201);
    expect(start.body.active).toBe(true);

    // А теперь scan от лица ВТО должен пройти и переключить
    // `currentOperationId` на операцию категории IRONING — это нужно
    // shopfloor-проекции (см. flows.md §F11). DTO ответа не отдаёт
    // `currentOperationId`, поэтому факт переключения проверяем
    // напрямую по БД — это и есть инвариант, на который дальше
    // опирается shopfloor-bucket «WTO».
    const scan = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.ironing)
      .send({});
    expect(scan.status).toBe(201);
    const afterScan = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: { currentOperationId: true, currentEmployeeId: true },
    });
    expect(afterScan.currentOperationId).toBe(seed.operations.IRONING.id);
    expect(afterScan.currentEmployeeId).toBe(seed.employees['ironing'].id);

    const detail = await request(t.app.getHttpServer())
      .get(`/api/wto/passports/${passportId}`)
      .set('Cookie', cookies.ironing)
      .expect(200);
    expect(detail.body.canCompleteWto).toBe(true);
    expect(detail.body.wtoCompletedAt).toBeNull();

    // «Завершить ВТО» — пишет WTO_PASSED, статус не трогает
    // (см. flows.md §F6, transaction `WtoService.completeWto`).
    const complete = await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);
    expect(typeof complete.body.wtoCompletedAt).toBe('string');
    expect(complete.body.status).toBe('IN_PROGRESS');
  });

  /**
   * Зеркало регрессии ОТК (инцидент 10.08.2026, см.
   * `qc-shift-flow.test.ts`): «Завершить ВТО» тоже обязано снимать
   * владельца, иначе паспорт навсегда остаётся «в работе» у отпарщика —
   * следующий исполнитель ловит на «Взять крой» 409
   * `PASSPORT_ALREADY_ISSUED`, а сам отпарщик не может переключить
   * смену (`SHIFT_HAS_ACTIVE_PASSPORTS`). На проде так зависли 47
   * паспортов на ВТО.
   */
  test('completeWto снимает паспорт с ВТО: currentEmployeeId=null, операция и шаг маршрута не тронуты', async () => {
    const passportId = await prepareInProgressPassport(true);
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

    const before = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: {
        currentEmployeeId: true,
        currentOperationId: true,
        currentRouteStepIndex: true,
      },
    });
    expect(before.currentEmployeeId).toBe(seed.employees['ironing'].id);

    await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
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
   * Зеркало ОТК-сценария из `qc-shift-flow.test.ts` (инцидент
   * 19.08.2026). После «Завершить ВТО» паспорт остаётся стоять на ВТО и
   * лежит у отпарщика — и уходит в повторный скан из стопки. Пока
   * `completeWto` владельца не снимал, такой скан гасила ветка
   * `sameOp && sameEmployee`; после фикса 10.08.2026 владельца нет, и
   * скан снова забирал проверенный паспорт на руки — так на проде
   * зависли 5 паспортов O-20260530-0001 (11.08.2026).
   *
   * Контракт: скан проверенного паспорта — no-op, а карточка
   * по-прежнему открывается (`removedFromWto=false`).
   */
  test('повторный scan уже отпаренного паспорта — no-op: ни события, ни владельца, карточка открыта', async () => {
    const passportId = await prepareInProgressPassport(true);
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
    await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);

    const scansBefore = await t.prisma.passportEvent.count({
      where: { passportId, type: 'OPERATION_SCAN' },
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);

    const after = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: {
        currentEmployeeId: true,
        currentOperationId: true,
        status: true,
      },
    });
    expect(after.currentEmployeeId).toBeNull();
    expect(after.currentOperationId).toBe(seed.operations.IRONING.id);
    expect(after.status).toBe('IN_PROGRESS');
    const scansAfter = await t.prisma.passportEvent.count({
      where: { passportId, type: 'OPERATION_SCAN' },
    });
    expect(scansAfter).toBe(scansBefore);

    const detail = await request(t.app.getHttpServer())
      .get(`/api/wto/passports/${passportId}`)
      .set('Cookie', cookies.ironing)
      .expect(200);
    expect(detail.body.removedFromWto).toBe(false);
    expect(typeof detail.body.wtoCompletedAt).toBe('string');
  });

  /**
   * Вторая половина фикса — для паспортов, где лишний скан уже записан
   * (продовый бэклог). `removedFromWto` считает «ушёл дальше» только по
   * сканам НЕ-ВТО операций, поэтому карточка открывается и повторное
   * «Завершить ВТО» снимает висящего владельца без мастера.
   */
  test('лишний ВТО-скан в истории не считается уходом на следующую операцию', async () => {
    const passportId = await prepareInProgressPassport(true);
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
    await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);

    await t.prisma.passportEvent.create({
      data: {
        passportId,
        type: 'OPERATION_SCAN',
        operationId: seed.operations.IRONING.id,
        employeeId: seed.employees['ironing'].id,
        qty: 1,
      },
    });
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { currentEmployeeId: seed.employees['ironing'].id },
    });

    const detail = await request(t.app.getHttpServer())
      .get(`/api/wto/passports/${passportId}`)
      .set('Cookie', cookies.ironing)
      .expect(200);
    expect(detail.body.removedFromWto).toBe(false);

    await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);
    const after = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: { currentEmployeeId: true },
    });
    expect(after.currentEmployeeId).toBeNull();
  });

  test('GET /api/shifts/meta для IRONING возвращает ironing-station с allow-листом {IRONING} — start-shift форма получает то же, что у швеи', async () => {
    // Проверяем backend-side контракт, на который опирается
    // `SeamstressShiftStart` на /wto: оборудование `ironing-station-01`
    // отдаётся активным с `allowedOperationIds`, содержащим операцию
    // категории IRONING. Без этого UI не построил бы список «доступные
    // операции» для WTO-смены.
    const meta = await request(t.app.getHttpServer())
      .get('/api/shifts/meta')
      .set('Cookie', cookies.ironing)
      .expect(200);

    const wtoStation = (meta.body.equipment as Array<{
      code: string;
      active: boolean;
      allowedOperationIds: string[];
    }>).find((e) => e.code === 'ironing-station-01');
    expect(wtoStation, 'ironing-station-01 must be present in meta').toBeDefined();
    expect(wtoStation!.active).toBe(true);
    expect(wtoStation!.allowedOperationIds).toContain(
      seed.operations.IRONING.id,
    );
  });

  // ---------------------------------------------------------------------------
  // P0-6: дополнительные WTO-инварианты (см. docs/test-gap-plan.md §P0-6).
  // ---------------------------------------------------------------------------

  /**
   * `WtoService.completeWto` сначала проверяет статус+категорию, и
   * только потом `assertQcPassed`. Чтобы добраться до проверки QC и
   * получить именно `PASSPORT_NOT_QC_PASSED`, нужен паспорт уже на
   * операции категории `IRONING`. Через scan такое состояние недостижимо
   * (входной QC-gate в `PassportsService.scanOnOperation:826-840` тоже
   * блокирует), поэтому artificially выставляем `currentOperationId`
   * напрямую через Prisma — это test-only short-circuit, никакого
   * изменения production-кода.
   */
  test('completeWto без QC_PASSED → 409 PASSPORT_NOT_QC_PASSED, без WTO-сайд-эффектов', async () => {
    const passportId = await prepareInProgressPassport(false);
    // Принудительно ставим passport на IRONING без QC_PASSED события.
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { currentOperationId: seed.operations.IRONING.id },
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSPORT_NOT_QC_PASSED');

    // WTO-сайд-эффекты не созданы.
    const wtoEvents = await t.prisma.passportEvent.count({
      where: { passportId, type: 'WTO_PASSED' },
    });
    expect(wtoEvents).toBe(0);
    const wtoAudit = await t.prisma.auditLog.count({
      where: { event: 'WTO_COMPLETED', entityType: 'WTO', entityId: passportId },
    });
    expect(wtoAudit).toBe(0);

    // Контрольно: passport не сдвинулся в терминальный статус.
    const after = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: { status: true, currentOperationId: true },
    });
    expect(after.status).toBe('IN_PROGRESS');
    expect(after.currentOperationId).toBe(seed.operations.IRONING.id);
  });

  /**
   * Row-level идемпотентность `completeWto` (симметрично QC, fixed в
   * `WtoService.completeWto`): второй клик возвращает успешный detail,
   * но НЕ пишет ни второй `PassportEvent(WTO_PASSED)`, ни вторую
   * запись `AuditLog(WTO_COMPLETED)`, ни не сдвигает `wtoCompletedAt`.
   */
  test('completeWto × 2 идемпотентен: один WTO_PASSED, один WTO_COMPLETED, wtoCompletedAt стабилен', async () => {
    const passportId = await prepareInProgressPassport(true);

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

    const first = await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({});
    expect(first.status).toBe(201);
    const firstWtoAt = first.body.wtoCompletedAt as string;
    expect(typeof firstWtoAt).toBe('string');

    // Если бы сервис писал второй event, его timestamp был бы заметно
    // позже. Идемпотентность означает «тот же первый event».
    await new Promise((r) => setTimeout(r, 5));

    const second = await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({});
    expect(second.status).toBe(201);
    const secondWtoAt = second.body.wtoCompletedAt as string;
    expect(secondWtoAt).toBe(firstWtoAt);

    const events = await t.prisma.passportEvent.count({
      where: { passportId, type: 'WTO_PASSED' },
    });
    expect(events).toBe(1);
    const audit = await t.prisma.auditLog.count({
      where: { event: 'WTO_COMPLETED', entityType: 'WTO', entityId: passportId },
    });
    expect(audit).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Retroactive WTO для PACKED-паспортов (исторический бэклог, упакованных
  // до route-gate в `PackingService.addPassport`). Сервис разрешает
  // ровно одну запись `WTO_PASSED` для status==PACKED, чтобы оператор
  // мог дозаписать ВТО через UI «Завершить ВТО».
  // ---------------------------------------------------------------------------

  test('completeWto на PACKED с QC_PASSED, без WTO_PASSED → 201, пишет WTO_PASSED один раз; повторно → PASSPORT_NOT_WTOABLE', async () => {
    const passportId = await prepareInProgressPassport(true);
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { status: 'PACKED', currentEmployeeId: null, currentCellId: null },
    });

    const first = await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({});
    expect(first.status).toBe(201);
    expect(typeof first.body.wtoCompletedAt).toBe('string');
    expect(first.body.status).toBe('PACKED');

    const wtoEvents = await t.prisma.passportEvent.count({
      where: { passportId, type: 'WTO_PASSED' },
    });
    expect(wtoEvents).toBe(1);

    const second = await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PASSPORT_NOT_WTOABLE');

    const wtoEventsAfter = await t.prisma.passportEvent.count({
      where: { passportId, type: 'WTO_PASSED' },
    });
    expect(wtoEventsAfter).toBe(1);
  });

  test('completeWto на PACKED без QC_PASSED → 409 PASSPORT_NOT_QC_PASSED (порядок ОТК→ВТО сохраняется)', async () => {
    const passportId = await prepareInProgressPassport(false);
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { status: 'PACKED', currentEmployeeId: null, currentCellId: null },
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSPORT_NOT_QC_PASSED');

    const wtoEvents = await t.prisma.passportEvent.count({
      where: { passportId, type: 'WTO_PASSED' },
    });
    expect(wtoEvents).toBe(0);
  });

  test('WTO detail для PACKED с QC_PASSED, без WTO_PASSED показывает canCompleteWto=true', async () => {
    const passportId = await prepareInProgressPassport(true);
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { status: 'PACKED', currentEmployeeId: null, currentCellId: null },
    });

    const detail = await request(t.app.getHttpServer())
      .get(`/api/wto/passports/${passportId}`)
      .set('Cookie', cookies.ironing)
      .expect(200);
    expect(detail.body.canCompleteWto).toBe(true);
    expect(detail.body.wtoCompletedAt).toBeNull();
  });
});
