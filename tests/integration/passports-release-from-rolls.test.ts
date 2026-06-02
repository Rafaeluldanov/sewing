/**
 * Integration-тест: рулонный выпуск паспортов помощником раскройщика
 * (`POST /api/passports/release-from-rolls`, см.
 * `PassportsService.releaseFromRolls`).
 *
 * Контекст: раскрой и выпуск разведены по ролям. Раскройщик (`CUTTER`)
 * ведёт `CuttingTask` (раскладка `perLayerQty` по размерам + рулоны со
 * слоями) и завершает её (`DONE`). После этого выпуск паспортов целиком
 * у помощника (`CUTTER_ASSISTANT`): он выбирает размер и рулоны, а
 * количество и номер рулона backend берёт из задачи. На каждый рулон —
 * один паспорт с `qtyCut = слои рулона × раскладка размера`.
 *
 * Проверяем:
 *   1. Выпуск одного рулона: qty = layers × perLayerQty, rollOrdinal
 *      проставлен, сдельное за раскрой ушло раскройщику задачи
 *      (`CuttingTask.assignedToId`), а не помощнику.
 *   2. Идемпотентность: повторный выпуск того же рулона пропускается
 *      (`skipped`), дубля паспорта нет (кейс «сломался принтер»).
 *   3. «Выбрать все рулоны» = пакетный выпуск всех рулонов размера.
 *   4. `release-state` отдаёт размеры (с `perLayerQty`), рулоны и
 *      выпущенные пары; `ready-for-release` считает статус NEW/DONE.
 *   5. Остаток плана: qty > остатка → 422 PASSPORT_QTY_EXCEEDS_REMAINING.
 *   6. RBAC: раскройщик (`CUTTER`) больше не выпускает паспорта (403 на
 *      `POST /api/passports`).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {
  loginAs,
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — release passports from rolls', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: { assistant: string; cutter: string };
  let orderId: string;
  let sizeId: string;

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
    sizeId = seed.sizes.M;

    const assistant = await t.prisma.employee.upsert({
      where: { login: 'cas-release' },
      create: {
        login: 'cas-release',
        fullName: 'Cutter Assistant Release',
        role: 'CUTTER_ASSISTANT',
        active: true,
        pinHash: await bcrypt.hash('cas-release', 4),
      },
      update: { active: true, role: 'CUTTER_ASSISTANT' },
    });
    cookies = {
      assistant: loginAs(t, {
        id: assistant.id,
        login: assistant.login,
        role: assistant.role,
        fullName: assistant.fullName,
      }),
      cutter: loginAs(t, seed.employees['cutter']),
    };
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Заказ IN_PRODUCTION + завершённая задача раскройщика с раскладкой по
   * размеру M (`perLayerQty`) и рулонами (`ordinal/layers`). Раскройщик
   * задачи = seed `cutter`.
   */
  async function setupOrderWithCuttingTask(opts: {
    qtyPlan: number;
    perLayerQty: number;
    rolls: Array<{ ordinal: number; layers: number }>;
  }): Promise<void> {
    const order = await t.prisma.order.create({
      data: {
        number: `O-ROLL-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        // MARKETPLACE → фиксированная схема начисления (CUT_CUT FIXED
        // rate из seed): immediate-начисление за раскрой создаётся
        // детерминированно, без зависимости от маршрута пошива.
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        items: {
          create: { productId: seed.product.id, sizeId, qtyPlan: opts.qtyPlan },
        },
      },
    });
    orderId = order.id;

    await t.prisma.cuttingTask.create({
      data: {
        orderId: order.id,
        status: 'DONE',
        assignedToId: seed.employees['cutter'].id,
        startedAt: new Date(),
        completedAt: new Date(),
        sizeRows: {
          create: {
            sortOrder: 10,
            sizeId,
            sizeCodeSnapshot: 'M',
            qtyPlan: opts.qtyPlan,
            perLayerQty: opts.perLayerQty,
          },
        },
        rolls: { create: opts.rolls },
      },
    });
  }

  function releaseBody(rollOrdinals: number[]): Record<string, unknown> {
    return {
      orderId,
      sizeId,
      cutDate: '2026-06-02T00:00:00.000Z',
      rollOrdinals,
    };
  }

  async function immediateCutterEntryEmployee(
    passportId: string,
  ): Promise<string | null> {
    const entry = await t.prisma.operationEntry.findFirst({
      where: { passportId, sourceEventType: 'PASSPORT_CREATED' },
      select: { employeeId: true },
    });
    return entry?.employeeId ?? null;
  }

  // ---------------------------------------------------------------------------
  // 1. Выпуск одного рулона
  // ---------------------------------------------------------------------------

  test('выпуск рулона: qty = слои × раскладка, начисление раскройщику задачи', async () => {
    await setupOrderWithCuttingTask({
      qtyPlan: 100,
      perLayerQty: 2,
      rolls: [
        { ordinal: 1, layers: 10 },
        { ordinal: 2, layers: 5 },
      ],
    });

    const r = await request(t.app.getHttpServer())
      .post('/api/passports/release-from-rolls')
      .set('Cookie', cookies.assistant)
      .send(releaseBody([1]));
    expect(r.status).toBe(201);
    expect(r.body.created).toHaveLength(1);
    expect(r.body.skipped).toEqual([]);

    const p = r.body.created[0];
    expect(p.qtyCut).toBe(20); // 10 слоёв × 2 на настиле
    expect(p.rollOrdinal).toBe(1);

    const dbPassport = await t.prisma.passport.findUnique({
      where: { id: p.id },
      select: { rollOrdinal: true, qtyCut: true, cutterId: true, sizeId: true },
    });
    expect(dbPassport).toMatchObject({
      rollOrdinal: 1,
      qtyCut: 20,
      cutterId: seed.employees['cutter'].id,
      sizeId,
    });

    // Сдельное за раскрой ушло раскройщику задачи, не помощнику.
    const attributed = await immediateCutterEntryEmployee(p.id);
    expect(attributed).toBe(seed.employees['cutter'].id);
  });

  // ---------------------------------------------------------------------------
  // 2. Идемпотентность — кейс «сломался принтер»
  // ---------------------------------------------------------------------------

  test('повторный выпуск того же рулона пропускается, дубля нет', async () => {
    await setupOrderWithCuttingTask({
      qtyPlan: 100,
      perLayerQty: 2,
      rolls: [
        { ordinal: 1, layers: 10 },
        { ordinal: 2, layers: 5 },
      ],
    });

    await request(t.app.getHttpServer())
      .post('/api/passports/release-from-rolls')
      .set('Cookie', cookies.assistant)
      .send(releaseBody([1]))
      .expect(201);

    // Повторяем по рулону 1 + добавляем рулон 2.
    const r = await request(t.app.getHttpServer())
      .post('/api/passports/release-from-rolls')
      .set('Cookie', cookies.assistant)
      .send(releaseBody([1, 2]));
    expect(r.status).toBe(201);
    expect(r.body.skipped).toEqual([1]);
    expect(r.body.created).toHaveLength(1);
    expect(r.body.created[0].rollOrdinal).toBe(2);

    // Всего по заказу/размеру 2 паспорта (по одному на рулон).
    const count = await t.prisma.passport.count({
      where: { orderId, sizeId },
    });
    expect(count).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // 3. «Выбрать все рулоны» — пакетный выпуск
  // ---------------------------------------------------------------------------

  test('выпуск всех рулонов размера разом', async () => {
    await setupOrderWithCuttingTask({
      qtyPlan: 100,
      perLayerQty: 3,
      rolls: [
        { ordinal: 1, layers: 4 },
        { ordinal: 2, layers: 6 },
      ],
    });

    const r = await request(t.app.getHttpServer())
      .post('/api/passports/release-from-rolls')
      .set('Cookie', cookies.assistant)
      .send(releaseBody([1, 2]));
    expect(r.status).toBe(201);
    expect(r.body.created).toHaveLength(2);

    const qtyByOrdinal = Object.fromEntries(
      r.body.created.map((p: { rollOrdinal: number; qtyCut: number }) => [
        p.rollOrdinal,
        p.qtyCut,
      ]),
    );
    expect(qtyByOrdinal).toEqual({ 1: 12, 2: 18 }); // 4×3, 6×3
  });

  // ---------------------------------------------------------------------------
  // 4. release-state + ready-for-release
  // ---------------------------------------------------------------------------

  test('release-state и ready-for-release отражают прогресс выпуска', async () => {
    await setupOrderWithCuttingTask({
      qtyPlan: 100,
      perLayerQty: 2,
      rolls: [
        { ordinal: 1, layers: 10 },
        { ordinal: 2, layers: 5 },
      ],
    });

    // До выпуска: оба рулона свободны, статус NEW, 0/2.
    const state0 = await request(t.app.getHttpServer())
      .get(`/api/cutting-tasks/by-order/${orderId}/release-state`)
      .set('Cookie', cookies.assistant);
    expect(state0.status).toBe(200);
    expect(state0.body.cuttingTaskStatus).toBe('DONE');
    expect(state0.body.sizes).toEqual([
      expect.objectContaining({ sizeId, perLayerQty: 2, qtyPlan: 100 }),
    ]);
    expect(state0.body.rolls).toHaveLength(2);
    expect(state0.body.released).toEqual([]);

    const ready0 = await request(t.app.getHttpServer())
      .get('/api/cutting-tasks/ready-for-release')
      .set('Cookie', cookies.assistant);
    const row0 = ready0.body.find(
      (o: { orderId: string }) => o.orderId === orderId,
    );
    expect(row0).toMatchObject({ status: 'NEW', totalPairs: 2, releasedPairs: 0 });

    // Выпускаем оба рулона.
    await request(t.app.getHttpServer())
      .post('/api/passports/release-from-rolls')
      .set('Cookie', cookies.assistant)
      .send(releaseBody([1, 2]))
      .expect(201);

    const state1 = await request(t.app.getHttpServer())
      .get(`/api/cutting-tasks/by-order/${orderId}/release-state`)
      .set('Cookie', cookies.assistant);
    expect(state1.body.released).toHaveLength(2);

    const ready1 = await request(t.app.getHttpServer())
      .get('/api/cutting-tasks/ready-for-release')
      .set('Cookie', cookies.assistant);
    const row1 = ready1.body.find(
      (o: { orderId: string }) => o.orderId === orderId,
    );
    expect(row1).toMatchObject({ status: 'DONE', totalPairs: 2, releasedPairs: 2 });
  });

  // ---------------------------------------------------------------------------
  // 5. Остаток плана
  // ---------------------------------------------------------------------------

  test('qty рулона превышает остаток плана → 422 PASSPORT_QTY_EXCEEDS_REMAINING', async () => {
    // План 15, а рулон даёт 10×2 = 20 > 15.
    await setupOrderWithCuttingTask({
      qtyPlan: 15,
      perLayerQty: 2,
      rolls: [{ ordinal: 1, layers: 10 }],
    });

    const r = await request(t.app.getHttpServer())
      .post('/api/passports/release-from-rolls')
      .set('Cookie', cookies.assistant)
      .send(releaseBody([1]));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('QTY_EXCEEDS_REMAINING_PLAN');

    const count = await t.prisma.passport.count({ where: { orderId } });
    expect(count).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 6. RBAC: раскройщик больше не выпускает паспорта
  // ---------------------------------------------------------------------------

  test('CUTTER получает 403 на POST /api/passports', async () => {
    await setupOrderWithCuttingTask({
      qtyPlan: 100,
      perLayerQty: 2,
      rolls: [{ ordinal: 1, layers: 10 }],
    });

    const r = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.cutter)
      .send({
        orderId,
        sizeId,
        rollNumber: 'R-1',
        cutDate: '2026-06-02T00:00:00.000Z',
        qtyCut: 5,
      });
    expect(r.status).toBe(403);
  });
});
