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
   */
  async function prepareInProgressPassport(): Promise<string> {
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
        rollNumber: 'R-QC-01',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
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
});
