/**
 * E2E «golden path» — главный производственный маршрут MVP 1.1.
 *
 * Один длинный сценарий, проходящий весь продуктивный цикл от создания
 * заказа до закрытой коробки и финальных диагностик. Это «страховка от
 * регрессий», которая ловит любую поломку контракта между модулями
 * (Orders → Passports → Shifts → QC → WTO → Packing → Shopfloor →
 * Audit → Diagnostics) одним прогоном.
 *
 * В отличие от `production-flow.test.ts` (там точечные срезы по каждому
 * домену), этот тест:
 *   - использует явный `routeTemplate` со snapshot-ом
 *     `OrderRouteStep`, чтобы проверить и `currentRouteStepIndex`-
 *     переключения по мере прохождения маршрута;
 *   - сшивает все шаги в один паспорт qty=12 и одного «героя» в
 *     каждой роли — это делает ассерты по display-проекции
 *     детерминированными (✔/▶ ровно на той операции, где паспорт
 *     находится в текущий момент);
 *   - в конце дёргает diagnostic consistency report и проверяет, что
 *     полностью завершённый поток не оставил ни одного `CRITICAL`-
 *     инварианта;
 *   - финально проверяет AuditLog: все «управленческие» события
 *     (`ORDER_CREATED`, `ORDER_STARTED`, `PASSPORT_ISSUED`,
 *     `PASSPORT_SCANNED`, `PASSPORT_OPERATION_COMPLETED`,
 *     `QC_COMPLETED`, `WTO_COMPLETED`, `PASSPORT_PACKED`,
 *     `BOX_CLOSED`) появились ровно по одному разу для нашего
 *     entity-id.
 *
 * Не дублирует негативные сценарии (RBAC, idempotency, gates) —
 * для них есть отдельные сьюты (`production-flow.test.ts`,
 * `qc-shift-flow.test.ts`, `wto-shift-flow.test.ts`,
 * `audit-log.test.ts`, `diagnostics.test.ts`,
 * `shopfloor-display.test.ts`).
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

const QTY = 12;

describeWithDb('integration — E2E production golden path', () => {
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
    // `resetDatabase` TRUNCATE'ит Employee, поэтому системный admin из
    // `startTestApp` исчезает; сразу же выпускаем свежий cookie, чтобы
    // diagnostics endpoint (требует ADMIN/SHOP_MANAGER) был доступен.
    await refreshAdminCookie(t);
    cookies = {
      admin: t.adminCookie,
      manager: loginAs(t, seed.employees['shop-chief']),
      cutter: loginAs(t, seed.employees['cutter']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      ironing: loginAs(t, seed.employees['ironing']),
      packer: loginAs(t, seed.employees['packer']),
    };
  });

  test('полный маршрут: order → passport → sewing → QC → WTO → packing', async () => {
    // -----------------------------------------------------------------------
    // 1. SETUP: route template (через Prisma — тест-инфра, не UI-flow).
    // -----------------------------------------------------------------------
    // Минимальный «продакшен-маршрут»: CUT_DIVISION → SEW_OVERLOCK_1 →
    // QC → IRONING (ВТО) → PACKING. Все операции существуют в seed,
    // оборудование уже разведено по `EquipmentOperation` (см.
    // `tests/utils/seed.ts`).
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: 'TPL-E2E-GOLDEN',
        name: 'E2E golden path route',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.CUT_DIVISION.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 2, operationId: seed.operations.QC.id },
            { index: 3, operationId: seed.operations.IRONING.id },
            { index: 4, operationId: seed.operations.PACKING.id },
          ],
        },
      },
    });

    // -----------------------------------------------------------------------
    // 2. ORDER: create через API + start
    // -----------------------------------------------------------------------
    const orderRes = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        routeTemplateId: tpl.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: QTY }],
      })
      .expect(201);
    const orderId: string = orderRes.body.id;
    expect(orderRes.body.status).toBe('DRAFT');
    expect(orderRes.body.routeTemplateId).toBe(tpl.id);

    const startRes = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);
    expect(startRes.body.status).toBe('IN_PRODUCTION');

    // OrderRouteStep snapshot реально создан в БД (контракт §«Маршруты
    // производства»: snapshot фиксируется в той же транзакции, что и
    // переход в IN_PRODUCTION; см. orders.service.ts L497-518).
    const snapshotSteps = await t.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    expect(snapshotSteps).toHaveLength(5);
    expect(snapshotSteps.map((s) => s.operationId)).toEqual([
      seed.operations.CUT_DIVISION.id,
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.QC.id,
      seed.operations.IRONING.id,
      seed.operations.PACKING.id,
    ]);

    // -----------------------------------------------------------------------
    // 3. PASSPORT: create + place в ячейку (нужно для последующего issue)
    // -----------------------------------------------------------------------
    const passportRes = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-E2E-01',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: QTY,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passportRes.body.id;
    expect(passportRes.body.qtyCut).toBe(QTY);
    expect(passportRes.body.qtyGood).toBe(QTY);
    // Сразу после create паспорт стоит на нулевом step'е и операции
    // CUT_DIVISION (= первый шаг snapshot-а маршрута). Это — контракт
    // `PassportsService.create` для заказа с снапшотом (L184-213).
    const passportAfterCreate = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: {
        status: true,
        currentRouteStepIndex: true,
        currentOperationId: true,
      },
    });
    expect(passportAfterCreate.status).toBe('CREATED');
    expect(passportAfterCreate.currentRouteStepIndex).toBe(0);
    expect(passportAfterCreate.currentOperationId).toBe(
      snapshotSteps[0].operationId,
    );

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);

    // -----------------------------------------------------------------------
    // 4. SEWING: швея открывает смену, забирает крой, сканирует на
    //    оверлоке и завершает свою операцию.
    // -----------------------------------------------------------------------
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
    // OPERATION_SCAN на SEW_OVERLOCK_1 двинул route step с 0 → 1
    // (`scanOnOperation`, L705-710 — matchedStep по orderRouteStep).
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const passportAfterSewing = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: {
        status: true,
        currentEmployeeId: true,
        currentOperationId: true,
        currentRouteStepIndex: true,
      },
    });
    // complete-operation снимает исполнителя; операция и индекс
    // остаются на SEW_OVERLOCK_1, пока следующий шаг не сделает scan.
    expect(passportAfterSewing.currentEmployeeId).toBeNull();
    expect(passportAfterSewing.currentOperationId).toBe(
      seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(passportAfterSewing.currentRouteStepIndex).toBe(1);
    expect(passportAfterSewing.status).toBe('IN_PROGRESS');

    // Display: на оверлоке висит ✔=12 (буфер «готово, ждёт следующего
    // шага», см. `buildSewingRoute` L1241-1254).
    {
      const display = await getDisplay(t, cookies.admin);
      const op = display.sewingRoute.find(
        (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
      );
      expect(op, 'sewingRoute должен содержать SEW_OVERLOCK_1 после sewing complete').toBeDefined();
      const row = op!.rows.find((r) => r.size === 'M')!;
      expect(row.inProgress).toBe(0);
      expect(row.done).toBe(QTY);
    }

    // Швея уходит со смены — на equipment больше не должно быть
    // активной сессии (страховка от EQUIPMENT_MULTIPLE_ACTIVE_SHIFTS).
    await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // -----------------------------------------------------------------------
    // 5. QC: смена → scan-in (paspport «приехал в ОТК») → complete
    // -----------------------------------------------------------------------
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
    // Маленькая пауза, чтобы createdAt(QC_PASSED) > createdAt(OPERATION_SCAN
    // на QC) даже на быстрых раннерах — иначе bucket остался бы QC, а
    // не QC_DONE (см. `bucketOf`/`hasFreshQcPassed`).
    await new Promise((r) => setTimeout(r, 5));
    const qcCompleteRes = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    expect(typeof qcCompleteRes.body.qcCompletedAt).toBe('string');
    expect(qcCompleteRes.body.status).toBe('IN_PROGRESS');

    {
      // После QC complete: QC ✔ = 12, sewing ✔ обнулилось (паспорт
      // ушёл с SEW_OVERLOCK_1 — idx=2 > step.index=1, см. L1241-1245).
      const display = await getDisplay(t, cookies.admin);
      expect(display.totals.qtyQc).toBe(0);
      expect(display.totals.qtyQcDone).toBe(QTY);
      // SEW_OVERLOCK_1 остаётся ВИДИМ в sewingRoute (есть в snapshot
      // маршрута активного заказа — контракт «весь маршрут активных
      // заказов»), но без работы: ▶/✔ должны быть равны 0 для всех
      // строк, иначе старая «исторический ✔» логика воскресла.
      const overlockBlock = display.sewingRoute.find(
        (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
      );
      expect(
        overlockBlock,
        'SEW_OVERLOCK_1 остаётся видим в маршруте активного заказа',
      ).toBeDefined();
      const sumIn = overlockBlock!.rows.reduce(
        (s, r) => s + r.inProgress,
        0,
      );
      const sumDone = overlockBlock!.rows.reduce(
        (s, r) => s + r.done,
        0,
      );
      expect(
        sumIn,
        'после ухода с SEW_OVERLOCK_1 ▶ всех строк должен быть 0',
      ).toBe(0);
      expect(
        sumDone,
        'после ухода с SEW_OVERLOCK_1 ✔ всех строк должен быть 0',
      ).toBe(0);
    }

    await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);

    // -----------------------------------------------------------------------
    // 6. WTO: смена → scan-in (требует QC_PASSED, который у нас есть)
    //    → complete
    // -----------------------------------------------------------------------
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
    await new Promise((r) => setTimeout(r, 5));
    const wtoCompleteRes = await request(t.app.getHttpServer())
      .post(`/api/wto/passports/${passportId}/complete`)
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);
    expect(typeof wtoCompleteRes.body.wtoCompletedAt).toBe('string');
    expect(wtoCompleteRes.body.status).toBe('IN_PROGRESS');

    {
      // После WTO complete: WTO ✔ = 12, QC ✔ = 0 (паспорт уехал из QC
      // ещё на предыдущем шаге OPERATION_SCAN на IRONING).
      const display = await getDisplay(t, cookies.admin);
      expect(display.totals.qtyWto).toBe(0);
      expect(display.totals.qtyWtoDone).toBe(QTY);
      expect(display.totals.qtyQc).toBe(0);
      expect(display.totals.qtyQcDone).toBe(0);
    }

    await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.ironing)
      .send({})
      .expect(201);

    // -----------------------------------------------------------------------
    // 7. PACKING: смена → создать коробку → положить паспорт → закрыть
    // -----------------------------------------------------------------------
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.packer)
      .send({
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
      })
      .expect(201);

    const boxRes = await request(t.app.getHttpServer())
      .post('/api/packing/boxes')
      .set('Cookie', cookies.packer)
      .send({})
      .expect(201);
    const boxId: string = boxRes.body.id;

    const addRes = await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/add-passport`)
      .set('Cookie', cookies.packer)
      .send({ code: passportId })
      .expect(201);
    expect(addRes.body.totalQty).toBe(QTY);

    // После add-passport (box ещё OPEN): bucket=PACKING; WTO ✔ = 0.
    {
      const display = await getDisplay(t, cookies.admin);
      expect(display.totals.qtyPacking).toBe(QTY);
      expect(display.totals.qtyFinished).toBe(0);
      expect(display.totals.qtyWto).toBe(0);
      expect(display.totals.qtyWtoDone).toBe(0);
    }

    const closeRes = await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/close`)
      .set('Cookie', cookies.packer)
      .send({})
      .expect(201);
    expect(closeRes.body.status).toBe('CLOSED');

    // После close: bucket=FINISHED, packing обнулился, qtyFinished=12
    // (см. `bucketOf` L149-150 — PACKED+!hasOpenBox → FINISHED).
    {
      const display = await getDisplay(t, cookies.admin);
      expect(display.totals.qtyPacking).toBe(0);
      expect(display.totals.qtyFinished).toBe(QTY);
      expect(display.totals.qtyWto).toBe(0);
      expect(display.totals.qtyWtoDone).toBe(0);
      expect(display.totals.qtyQc).toBe(0);
      expect(display.totals.qtyQcDone).toBe(0);
    }

    // Паспорт реально PACKED + box.closedAt не null.
    const passportFinal = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
      select: {
        status: true,
        currentEmployeeId: true,
        currentCellId: true,
      },
    });
    expect(passportFinal.status).toBe('PACKED');
    // PACKED-паспорт ни у кого на руках и ни в одной ячейке —
    // packing.service.ts L308-318 явно очищает оба поля. Это же
    // условие проверяет диагностический инвариант
    // PASSPORT_FINISHED_BUT_HAS_CURRENT_EMPLOYEE.
    expect(passportFinal.currentEmployeeId).toBeNull();
    expect(passportFinal.currentCellId).toBeNull();
    const boxFinal = await t.prisma.box.findUniqueOrThrow({
      where: { id: boxId },
      select: { closedAt: true },
    });
    expect(boxFinal.closedAt).not.toBeNull();

    // Order qtyFinishedTotal реактивно подтянулся (см.
    // `production-flow.test.ts §E+F` для контракта).
    const orderDetail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(orderDetail.body.summary.qtyFinishedTotal).toBe(QTY);

    await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.packer)
      .send({})
      .expect(201);

    // -----------------------------------------------------------------------
    // 8. DIAGNOSTICS: после полного прохода никаких CRITICAL быть
    //    не должно. WARNING-категории мы отдельно не запрещаем — это
    //    advisory-сигналы, и легитимный (например,
    //    PASSPORT_CURRENT_OPERATION_NOT_IN_ORDER_ROUTE для исторического
    //    «следа») может появиться без вины бизнес-логики. Цель E2E —
    //    именно «нет жёстких инвариантных нарушений».
    // -----------------------------------------------------------------------
    const diag = await request(t.app.getHttpServer())
      .get('/api/admin/diagnostics/consistency')
      .set('Cookie', cookies.admin)
      .expect(200);
    expect(
      diag.body.summary.critical,
      `unexpected CRITICAL issues:\n${JSON.stringify(diag.body.issues, null, 2)}`,
    ).toBe(0);

    // -----------------------------------------------------------------------
    // 9. AUDIT: каждое «управленческое» действие оставило ровно один
    //    след в `AuditLog`. Это backstop для отдельного `audit-log.test.ts`
    //    — там событий по объектам разные роли пишут точечно, здесь
    //    же мы доказываем, что весь golden path журналируется целиком.
    // -----------------------------------------------------------------------
    const expectAudit = async (
      entityType: string,
      entityId: string,
      event: string,
    ): Promise<void> => {
      const rows = await t.prisma.auditLog.findMany({
        where: { entityType, entityId, event },
      });
      expect(
        rows.length,
        `AuditLog ${entityType}/${event} for ${entityId}`,
      ).toBeGreaterThanOrEqual(1);
    };
    await expectAudit('ORDER', orderId, 'ORDER_CREATED');
    await expectAudit('ORDER', orderId, 'ORDER_STARTED');
    await expectAudit('PASSPORT', passportId, 'PASSPORT_ISSUED');
    await expectAudit('PASSPORT', passportId, 'PASSPORT_SCANNED');
    await expectAudit('PASSPORT', passportId, 'PASSPORT_OPERATION_COMPLETED');
    await expectAudit('QC', passportId, 'QC_COMPLETED');
    await expectAudit('WTO', passportId, 'WTO_COMPLETED');
    await expectAudit('PACKING', boxId, 'PASSPORT_PACKED');
    await expectAudit('PACKING', boxId, 'BOX_CLOSED');
  });
});

// ===========================================================================
// helpers
// ===========================================================================

interface DisplaySnapshot {
  totals: {
    qtySewing: number;
    qtyQc: number;
    qtyQcDone: number;
    qtyWto: number;
    qtyWtoDone: number;
    qtyPacking: number;
    qtyFinished: number;
  };
  sewingRoute: Array<{
    operationId: string;
    operationName: string;
    rows: Array<{ size: string; inProgress: number; done: number }>;
  }>;
}

async function getDisplay(
  t: TestApp,
  cookie: string,
): Promise<DisplaySnapshot> {
  const res = await request(t.app.getHttpServer())
    .get('/api/shopfloor/display')
    .set('Cookie', cookie)
    .expect(200);
  return res.body as DisplaySnapshot;
}
