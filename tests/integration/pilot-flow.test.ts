/**
 * Integration-тест пилотных сценариев (Шаг 12 / Pilot Rollout).
 *
 * Эти сценарии — не «новый функционал». Это явная фиксация того, что
 * система держит «тонкие углы», на которых обычно ломаются пилоты:
 *
 *   1. double-scan stress — швея сканирует один и тот же паспорт
 *      несколько раз подряд (терминал залипает, паспорт случайно
 *      проскальзывает дважды). Система не должна плодить дубли
 *      событий/начислений и не должна возвращать 500.
 *   2. rapid issue+scan — несколько паспортов выдаются и сканируются
 *      в одной смене один за другим (типичная ситуация утром).
 *   3. pack after defect — паспорт получил брак на ОТК, потом был
 *      упакован: при упаковке должен попасть только `qtyGood`,
 *      а сам паспорт стать `PACKED` с правильными итогами.
 *
 * Также проверяем, что на 4xx-ответе в теле приходит `requestId`
 * (см. `docs/api.md §13`) — без этого вся бугфикс-схема пилота не
 * работает.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { PassportEventType, PassportStatus } from '@prisma/client';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — pilot flow (Шаг 12)', () => {
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
      packer: loginAs(t, seed.employees['packer']),
    };
  });

  // -------------------------------------------------------------------------
  // 1. DOUBLE SCAN STRESS
  // -------------------------------------------------------------------------

  test('double scan stress — пять подряд сканов одной смены не плодят события', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 3 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      3,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);

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
      .expect(201);

    for (let i = 0; i < 5; i += 1) {
      const r = await request(t.app.getHttpServer())
        .post(`/api/passports/${passportId}/scan`)
        .set('Cookie', cookies.seamstress);
      expect(r.status).toBe(201);
      expect(r.body.status).toBe('IN_PROGRESS');
    }

    const operationScans = await t.prisma.passportEvent.count({
      where: {
        passportId,
        type: PassportEventType.OPERATION_SCAN,
      },
    });
    // Ровно одно событие OPERATION_SCAN на (паспорт, операция, сотрудник)
    // — 4 повторных сканов превратились в no-op, см. ADR-0003 §6.
    expect(operationScans).toBe(1);

    const earnings = await t.prisma.operationEntry.findMany({
      where: { passportId, employeeId: seed.employees.seamstress.id },
    });
    expect(earnings.length).toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 2. RAPID ISSUE + SCAN — несколько паспортов в одной смене
  // -------------------------------------------------------------------------

  test('rapid issue + scan — три паспорта подряд проходят issue→scan чисто', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 3 },
      { sizeId: seed.sizes.S, qtyPlan: 3 },
      { sizeId: seed.sizes.L, qtyPlan: 3 },
    ]);
    await startOrder(t, orderId, cookies.manager);

    const passportIds: string[] = [];
    for (const sizeKey of ['S', 'M', 'L'] as const) {
      const id = await createPassport(
        t,
        cookies.manager,
        orderId,
        seed.sizes[sizeKey],
        2,
      );
      await placePassport(t, cookies.manager, id, seed.cells.A1.id);
      passportIds.push(id);
    }

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);

    for (const id of passportIds) {
      await request(t.app.getHttpServer())
        .post(`/api/passports/${id}/issue`)
        .set('Cookie', cookies.seamstress)
        .expect(201);
      const scan = await request(t.app.getHttpServer())
        .post(`/api/passports/${id}/scan`)
        .set('Cookie', cookies.seamstress);
      expect(scan.status).toBe(201);
      expect(scan.body.status).toBe('IN_PROGRESS');
    }

    const inProgress = await t.prisma.passport.count({
      where: {
        id: { in: passportIds },
        status: PassportStatus.IN_PROGRESS,
        currentEmployeeId: seed.employees.seamstress.id,
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
      },
    });
    expect(inProgress).toBe(passportIds.length);
  });

  // -------------------------------------------------------------------------
  // 3. PACK AFTER DEFECT — упаковываем только qtyGood
  // -------------------------------------------------------------------------

  test('pack after defect — паспорт упакован с qtyGood, brак учтён', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 5 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      5,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);

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
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .expect(201);

    const defect = await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/defects`)
      .set('Cookie', cookies.qc)
      .send({ defectTypeId: seed.defectType.id, qty: 2 });
    expect(defect.status).toBe(201);
    expect(defect.body.qtyDefect).toBe(2);
    expect(defect.body.qtyGood).toBe(3);

    await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.seamstress)
      .expect(201);

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.packer)
      .send({
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
      })
      .expect(201);

    const box = await request(t.app.getHttpServer())
      .post('/api/packing/boxes')
      .set('Cookie', cookies.packer)
      .send({})
      .expect(201);
    const boxId: string = box.body.id;

    const add = await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/add-passport`)
      .set('Cookie', cookies.packer)
      .send({ code: passportId });
    expect(add.status).toBe(201);
    // В коробку идёт только qtyGood, не qtyCut.
    expect(add.body.totalQty).toBe(3);

    // Повторная упаковка того же паспорта — заблокирована.
    const dup = await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/add-passport`)
      .set('Cookie', cookies.packer)
      .send({ code: passportId });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('PASSPORT_ALREADY_PACKED');
    // Шаг 12: requestId обязан присутствовать в каждом ошибочном ответе.
    expect(typeof dup.body.requestId).toBe('string');
    expect(dup.body.requestId.length).toBeGreaterThan(0);
    expect(dup.headers['x-request-id']).toBe(dup.body.requestId);

    // Заказ: qtyFinishedTotal = qtyGood = 3, qtyDefectTotal = 2.
    const orderDetail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager);
    expect(orderDetail.body.summary.qtyFinishedTotal).toBe(3);
    expect(orderDetail.body.summary.qtyDefectTotal).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 4. SAFETY GUARDS
  // -------------------------------------------------------------------------

  test('safety — нельзя сканировать PACKED паспорт', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 2 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      2,
    );
    await placePassport(t, cookies.manager, passportId, seed.cells.A1.id);

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
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.seamstress)
      .expect(201);

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.packer)
      .send({
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
      })
      .expect(201);
    const box = await request(t.app.getHttpServer())
      .post('/api/packing/boxes')
      .set('Cookie', cookies.packer)
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${box.body.id}/add-passport`)
      .set('Cookie', cookies.packer)
      .send({ code: passportId })
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/shifts/stop')
      .set('Cookie', cookies.packer)
      .expect(201);

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_2.id,
      })
      .expect(201);

    const blocked = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PASSPORT_ALREADY_PACKED');
    expect(typeof blocked.body.requestId).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 5. ADMIN OVERVIEW
  // -------------------------------------------------------------------------

  test('admin overview — счётчики реактивны и доступны только SHOP_MANAGER/ADMIN', async () => {
    const denied = await request(t.app.getHttpServer())
      .get('/api/admin/overview')
      .set('Cookie', cookies.seamstress);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN_ROLE');

    const empty = await request(t.app.getHttpServer())
      .get('/api/admin/overview')
      .set('Cookie', cookies.manager);
    expect(empty.status).toBe(200);
    expect(empty.body.counters.activeShifts).toBe(0);
    expect(empty.body.counters.openBoxes).toBe(0);

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);

    const after = await request(t.app.getHttpServer())
      .get('/api/admin/overview')
      .set('Cookie', cookies.manager);
    expect(after.status).toBe(200);
    expect(after.body.counters.activeShifts).toBe(1);
    expect(after.body.shifts).toHaveLength(1);
    expect(after.body.shifts[0].employeeName).toBe('Test Seamstress');
  });
});

// ===========================================================================
// helpers — намеренно дублируем production-flow, чтобы не вводить
// общий «test toolbox» — на пилоте проще читать каждый файл отдельно.
// ===========================================================================

async function createOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  items: Array<{ sizeId: string; qtyPlan: number }>,
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items,
    })
    .expect(201);
  return r.body.id;
}

async function startOrder(
  t: TestApp,
  orderId: string,
  cookie: string,
): Promise<void> {
  await request(t.app.getHttpServer())
    .post(`/api/orders/${orderId}/start`)
    .set('Cookie', cookie)
    .expect(201);
}

async function createPassport(
  t: TestApp,
  cookie: string,
  orderId: string,
  sizeId: string,
  qtyCut: number,
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/passports')
    .set('Cookie', cookie)
    .send({
      orderId,
      sizeId,
      rollNumber: `R-${Math.floor(Math.random() * 1e6)}`,
      cutDate: '2026-04-15T00:00:00.000Z',
      qtyCut,
    })
    .expect(201);
  return r.body.id;
}

async function placePassport(
  t: TestApp,
  cookie: string,
  passportId: string,
  cellId: string,
): Promise<void> {
  await request(t.app.getHttpServer())
    .post(`/api/passports/${passportId}/place`)
    .set('Cookie', cookie)
    .send({ cellId })
    .expect(201);
}
