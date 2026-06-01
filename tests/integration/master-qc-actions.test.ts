/**
 * Integration-тесты ОТК-действий мастера цеха над паспортами
 * (см. `apps/api/src/modules/master-actions/master-actions.controller.ts`,
 * план `ОТК-действия в кабинете мастера цеха`).
 *
 * Мастер может на любом этапе отсканировать паспорт и:
 *   - зафиксировать брак (`POST /api/master-actions/passports/:id/defect`);
 *   - вернуть на доработку швее
 *     (`POST /api/master-actions/passports/:id/return-to-rework`).
 *
 * Бизнес-логика делегируется в `QcService` (тот же код, что у роли QC),
 * актор — сам мастер. Покрываем:
 *   1. defect: `qtyGood` уменьшается, пишется `DEFECT_RECORDED` с
 *      `employeeId = master`;
 *   2. qc-detail: `eligibleReworkTargets` содержит завершённую
 *      SEW-операцию со швеёй-финишёром;
 *   3. return-to-rework: паспорт уходит на выбранную SEW-операцию,
 *      пишется `OPERATION_REWORK_OPENED`, audit
 *      `QC_PASSPORT_RETURNED_TO_REWORK` с `employeeId = master`;
 *   4. RBAC: `SEAMSTRESS` получает `403` на новые эндпоинты;
 *   5. CREATED-паспорт нельзя браковать → `409 PASSPORT_NOT_QCABLE`.
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

describeWithDb('integration — master QC actions', () => {
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
   * Паспорт, прошедший SEW_OVERLOCK_1 (есть `OPERATION_FINISHED` с
   * финишёром-швеёй) и стоящий на ОТК. Это даёт непустой
   * `eligibleReworkTargets` для возврата на доработку.
   */
  async function setupPassportAtQc(opts?: {
    status?: 'CREATED' | 'IN_PROGRESS';
    withFinishedSew?: boolean;
    qtyCut?: number;
  }): Promise<{ passportId: string; orderId: string }> {
    const status = opts?.status ?? 'IN_PROGRESS';
    const withFinishedSew = opts?.withFinishedSew ?? true;
    const qtyCut = opts?.qtyCut ?? 5;

    const order = await t.prisma.order.create({
      data: {
        number: `O-MQC-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: qtyCut },
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
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-MQC-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:mqc-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-MQC',
        cutDate: new Date(),
        qtyPlan: qtyCut,
        qtyCut,
        qtyGood: qtyCut,
        cutterId: seed.employees['cutter'].id,
        creatorId: seed.employees['cutter'].id,
        status,
        currentOperationId: seed.operations.QC.id,
        currentRouteStepIndex: 3,
        currentEmployeeId: null,
      },
    });
    if (withFinishedSew) {
      await t.prisma.passportEvent.create({
        data: {
          passportId: passport.id,
          type: 'OPERATION_FINISHED',
          employeeId: seed.employees['seamstress'].id,
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          qty: qtyCut,
          createdAt: new Date(Date.now() - 60_000),
        },
      });
    }
    return { passportId: passport.id, orderId: order.id };
  }

  test('master can record defect — qtyGood уменьшается, DEFECT_RECORDED от мастера', async () => {
    const { passportId } = await setupPassportAtQc({ qtyCut: 5 });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/defect`)
      .set('Cookie', cookies.master)
      .send({ defectTypeId: seed.defectType.id, qty: 2, comment: 'Пятно' });
    expect(res.status).toBe(201);
    expect(res.body.qtyDefect).toBe(2);
    expect(res.body.qtyGood).toBe(3);

    const passport = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(passport?.qtyDefect).toBe(2);
    expect(passport?.qtyGood).toBe(3);

    const event = await t.prisma.passportEvent.findFirst({
      where: { passportId, type: 'DEFECT_RECORDED' },
    });
    expect(event).not.toBeNull();
    expect(event?.employeeId).toBe(seed.employees['master'].id);
    expect(event?.qty).toBe(2);
  });

  test('qc-detail отдаёт eligibleReworkTargets со швеёй-финишёром', async () => {
    const { passportId } = await setupPassportAtQc();

    const res = await request(t.app.getHttpServer())
      .get(`/api/master-actions/passports/${passportId}/qc-detail`)
      .set('Cookie', cookies.master);
    expect(res.status).toBe(200);
    const target = res.body.eligibleReworkTargets.find(
      (x: { operationId: string }) =>
        x.operationId === seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(target).toBeTruthy();
    expect(target.finisherEmployeeId).toBe(seed.employees['seamstress'].id);
    expect(res.body.canReturnToRework).toBe(true);
  });

  test('master can return to rework — паспорт уходит на SEW, REWORK_OPENED, audit от мастера', async () => {
    const { passportId } = await setupPassportAtQc();

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/return-to-rework`)
      .set('Cookie', cookies.master)
      .send({ targetOperationId: seed.operations.SEW_OVERLOCK_1.id });
    expect(res.status).toBe(201);

    const passport = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(passport?.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(passport?.currentRouteStepIndex).toBe(1);

    const rework = await t.prisma.passportEvent.findFirst({
      where: { passportId, type: 'OPERATION_REWORK_OPENED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(rework?.operationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(rework?.employeeId).toBe(seed.employees['seamstress'].id);

    const audit = await t.prisma.auditLog.findFirst({
      where: { event: 'QC_PASSPORT_RETURNED_TO_REWORK', entityId: passportId },
    });
    expect(audit).not.toBeNull();
    expect(audit?.employeeId).toBe(seed.employees['master'].id);
  });

  test('RBAC — SEAMSTRESS получает 403 на ОТК-действия мастера', async () => {
    const { passportId } = await setupPassportAtQc();

    const detail = await request(t.app.getHttpServer())
      .get(`/api/master-actions/passports/${passportId}/qc-detail`)
      .set('Cookie', cookies.seamstress);
    expect(detail.status).toBe(403);

    const types = await request(t.app.getHttpServer())
      .get(`/api/master-actions/defect-types`)
      .set('Cookie', cookies.seamstress);
    expect(types.status).toBe(403);

    const defect = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/defect`)
      .set('Cookie', cookies.seamstress)
      .send({ defectTypeId: seed.defectType.id, qty: 1 });
    expect(defect.status).toBe(403);

    const rework = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/return-to-rework`)
      .set('Cookie', cookies.seamstress)
      .send({ targetOperationId: seed.operations.SEW_OVERLOCK_1.id });
    expect(rework.status).toBe(403);
  });

  test('CREATED-паспорт нельзя браковать → 409 PASSPORT_NOT_QCABLE', async () => {
    const { passportId } = await setupPassportAtQc({
      status: 'CREATED',
      withFinishedSew: false,
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/defect`)
      .set('Cookie', cookies.master)
      .send({ defectTypeId: seed.defectType.id, qty: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSPORT_NOT_QCABLE');
  });
});
