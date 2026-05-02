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
});
