/**
 * Integration-тест бакета `SEWING_DONE` («Сшито, ждёт ОТК») в проекции
 * `/api/shopfloor/state` и `/api/shopfloor/display`.
 * См. ADR-0013 §«SEWING_DONE bucket», `docs/screens.md §9.3`.
 *
 * Сценарий по живому примеру ФС-000003: паспорт на швейном шаге
 * проходит все три состояния бакета пошива:
 *
 *   1) швея взяла крой и отсканировала (на руках)        → `qtySewing`;
 *   2) швея нажала «Завершить операцию» (WIP-буфер)       → `qtySewingDone`;
 *   3) ОТК отсканировал (`OPERATION_SCAN`, категория QC)  → `qtyQc`;
 *   4) мастер откатил паспорт назад на швейный шаг в ячейку
 *      (`set-route-step` backward) — старый `OPERATION_FINISHED`
 *      старше скана ОТК, паспорт «ждёт выдачи»            → `qtySewing`;
 *   5) швея снова взяла паспорт (на руках)                 → `qtySewing`.
 *
 * На каждом шаге сумма живых бакетов не меняется (бакеты
 * взаимоисключающие), а `Passport.status` остаётся `IN_PROGRESS`.
 *
 * Повторное «Завершить операцию» после отката МАСТЕРОМ здесь не
 * гоняем: мастер (в отличие от `QcService.returnToRework`) не снимает
 * pending-начисление первого прохода, и второй `complete` падает на
 * `OperationEntry_idem` внутри интерактивной транзакции (P2002 →
 * 25P02 → 500). Это независимый дефект `completeOperationByEmployee`,
 * а не проекции; правило «свежий финиш по текущей операции снова
 * даёт SEWING_DONE» покрыто вторым тестом на уровне событий.
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

interface StateSummary {
  qtyCut: number;
  qtySewing: number;
  qtySewingDone: number;
  qtyQc: number;
  qtyQcDone: number;
  qtyWto: number;
  qtyWtoDone: number;
  qtyPacking: number;
  qtyFinished: number;
}

describeWithDb('integration — shopfloor SEWING_DONE bucket', () => {
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
    await refreshAdminCookie(t);
    cookies = {
      admin: t.adminCookie,
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      master: loginAs(t, seed.employees['master']),
    };
  });

  async function getState(orderId: string): Promise<{
    summary: StateSummary;
    rows: Array<StateSummary & { sizeCode: string }>;
  }> {
    const res = await request(t.app.getHttpServer())
      .get(`/api/shopfloor/state?orderId=${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    return res.body;
  }

  async function getDisplay(): Promise<{
    kpi: { inWork: number };
    totals: StateSummary;
    sewingRoute: Array<{
      operationId: string;
      rows: Array<{ size: string; inProgress: number; done: number }>;
    }>;
  }> {
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookies.admin)
      .expect(200);
    return res.body;
  }

  function sumLive(s: StateSummary): number {
    return (
      s.qtyCut +
      s.qtySewing +
      s.qtySewingDone +
      s.qtyQc +
      s.qtyQcDone +
      s.qtyWto +
      s.qtyWtoDone +
      s.qtyPacking +
      s.qtyFinished
    );
  }

  test('complete → qtySewingDone; скан ОТК → qtyQc; откат мастером → qtySewing; повторная выдача → qtySewing', async () => {
    // ---- 1. Маршрут CUT_DIVISION → SEW_OVERLOCK_1 → QC, заказ, паспорт ----
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: 'TPL-SEWING-DONE',
        name: 'Маршрут — SEWING_DONE',
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
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        routeTemplateId: tpl.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: QTY }],
      })
      .expect(201);
    const orderId: string = orderRes.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const passportRes = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-SD-01',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: QTY,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passportRes.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);

    // Крой в ячейке → CUT.
    {
      const s = await getState(orderId);
      expect(s.summary.qtyCut).toBe(QTY);
      expect(s.summary.qtySewing).toBe(0);
      expect(s.summary.qtySewingDone).toBe(0);
      expect(sumLive(s.summary)).toBe(QTY);
    }

    // ---- 2. Швея: смена → issue → scan (на руках) → SEWING ----
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
    {
      const s = await getState(orderId);
      expect(s.summary.qtySewing).toBe(QTY);
      expect(s.summary.qtySewingDone).toBe(0);
      expect(s.summary.qtyQc).toBe(0);
      expect(sumLive(s.summary)).toBe(QTY);
    }

    // ---- 3. «Завершить операцию» → SEWING_DONE (буфер, ждёт ОТК) ----
    // Пауза, чтобы createdAt(OPERATION_FINISHED) > createdAt(OPERATION_SCAN)
    // даже на быстрых раннерах (timestamp(3), см. аналогичную паузу перед
    // QC complete в e2e-production-flow).
    await new Promise((r) => setTimeout(r, 5));
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    {
      const inDb = await t.prisma.passport.findUniqueOrThrow({
        where: { id: passportId },
        select: { status: true, currentEmployeeId: true, currentOperationId: true },
      });
      expect(inDb.status).toBe('IN_PROGRESS');
      expect(inDb.currentEmployeeId).toBeNull();
      expect(inDb.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_1.id);

      const s = await getState(orderId);
      expect(s.summary.qtySewing).toBe(0);
      expect(s.summary.qtySewingDone).toBe(QTY);
      expect(s.summary.qtyQc).toBe(0);
      expect(sumLive(s.summary)).toBe(QTY);
      const rowM = s.rows.find((r) => r.sizeCode === 'M')!;
      expect(rowM.qtySewing).toBe(0);
      expect(rowM.qtySewingDone).toBe(QTY);

      // Дисплей: те же цифры в totals + KPI «В работе» включает буфер,
      // а sewingRoute показывает ✔ на Оверлоке 1 (согласовано с матрицей).
      const d = await getDisplay();
      expect(d.totals.qtySewing).toBe(0);
      expect(d.totals.qtySewingDone).toBe(QTY);
      expect(d.kpi.inWork).toBe(QTY);
      const ovl = d.sewingRoute.find(
        (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
      )!;
      const ovlM = ovl.rows.find((r) => r.size === 'M')!;
      expect(ovlM.inProgress).toBe(0);
      expect(ovlM.done).toBe(QTY);
    }

    // ---- 4. ОТК сканирует → QC (категория сменилась, буфер пошива пуст) ----
    await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
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
    await new Promise((r) => setTimeout(r, 5));
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    {
      const s = await getState(orderId);
      expect(s.summary.qtySewing).toBe(0);
      expect(s.summary.qtySewingDone).toBe(0);
      expect(s.summary.qtyQc).toBe(QTY);
      expect(sumLive(s.summary)).toBe(QTY);
    }

    // ---- 5. Мастер откатывает на швейный шаг в ячейку → SEWING («ждёт выдачи») ----
    // Старый OPERATION_FINISHED по Оверлоку 1 старше скана ОТК — свежим
    // не считается, паспорт лежит в ячейке и ждёт выдачи швее.
    await new Promise((r) => setTimeout(r, 5));
    const rollback = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/set-route-step`)
      .set('Cookie', cookies.master)
      .send({
        reason: 'ROUTE_CORRECTION',
        routeStepIndex: 1,
        cellQr: seed.cells.A1.qrCode,
      })
      .expect(201);
    expect(rollback.body.passport.currentEmployeeId).toBeNull();
    expect(rollback.body.passport.currentOperation?.id).toBe(
      seed.operations.SEW_OVERLOCK_1.id,
    );
    {
      const s = await getState(orderId);
      expect(s.summary.qtySewing).toBe(QTY);
      expect(s.summary.qtySewingDone).toBe(0);
      expect(s.summary.qtyQc).toBe(0);
      expect(sumLive(s.summary)).toBe(QTY);
    }

    // ---- 6. Переделка: швея снова берёт паспорт (на руках) → SEWING ----
    // Гейт `assertOperationNotFinished` пропускает повторную выдачу:
    // мастер при откате на завершённую операцию записал
    // `OPERATION_REWORK_OPENED`.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    await new Promise((r) => setTimeout(r, 5));
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    {
      const s = await getState(orderId);
      expect(s.summary.qtySewing).toBe(QTY);
      expect(s.summary.qtySewingDone).toBe(0);
      expect(s.summary.qtyQc).toBe(0);
      expect(sumLive(s.summary)).toBe(QTY);
    }
  });

  test('closeUnclosedOperation по старой операции не двигает паспорт, уехавший дальше', async () => {
    // OPERATION_FINISHED, дописанный по СТАРОЙ операции (долг швеи),
    // не должен переводить паспорт в SEWING_DONE: свежесть считается
    // только по ТЕКУЩЕЙ операции паспорта. Моделируем прямой записью
    // события: паспорт стоит на Оверлоке 2 без исполнителя (ждёт
    // выдачи), а финиш свежее любого скана — но по Оверлоку 1.
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: 'O-SD-STALE',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [{ productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 5 }],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_2.id },
          ],
        },
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: 'P-SD-STALE',
        qrCode: 'passport:sd-stale',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-SD-STALE',
        cutDate: today,
        qtyPlan: 5,
        qtyCut: 5,
        qtyGood: 5,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_2.id,
        currentEmployeeId: null,
        currentRouteStepIndex: 1,
      },
    });
    const t0 = new Date(today.getTime() - 60_000);
    const t1 = new Date(today.getTime() - 30_000);
    await t.prisma.passportEvent.createMany({
      data: [
        {
          passportId: passport.id,
          type: 'ISSUED_TO_EMPLOYEE',
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          employeeId: seed.employees.seamstress.id,
          createdAt: t0,
        },
        // Долг закрыт позже — но по Оверлоку 1, а паспорт уже на Оверлоке 2.
        {
          passportId: passport.id,
          type: 'OPERATION_FINISHED',
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          employeeId: seed.employees.seamstress.id,
          qty: 5,
          createdAt: t1,
        },
      ],
    });

    const s = await getState(order.id);
    expect(s.summary.qtySewing).toBe(5);
    expect(s.summary.qtySewingDone).toBe(0);

    // А финиш по ТЕКУЩЕЙ операции, свежее выдачи, — уже буфер.
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'OPERATION_FINISHED',
        operationId: seed.operations.SEW_OVERLOCK_2.id,
        employeeId: seed.employees.seamstress.id,
        qty: 5,
        createdAt: today,
      },
    });
    const s2 = await getState(order.id);
    expect(s2.summary.qtySewing).toBe(0);
    expect(s2.summary.qtySewingDone).toBe(5);

    // Откат: паспорт снова без исполнителя на той же операции, но после
    // финиша появился более свежий «перехват» (скан следующего шага /
    // выдача) — финиш больше не свежий, паспорт «ждёт выдачи» → SEWING.
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'OPERATION_SCAN',
        operationId: seed.operations.QC.id,
        employeeId: seed.employees.qc.id,
        createdAt: new Date(today.getTime() + 1_000),
      },
    });
    const s3 = await getState(order.id);
    expect(s3.summary.qtySewing).toBe(5);
    expect(s3.summary.qtySewingDone).toBe(0);
  });
});
