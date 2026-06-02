/**
 * Integration-тесты `PassportsService.completeOperationsBatch` —
 * пакетное завершение операций швеёй сразу по нескольким паспортам
 * (UX /work: отметила чекбоксами «Текущий крой» → «Завершить
 * выбранные»). Endpoint: `POST /api/passports/batch/complete-operations`.
 *
 * Здесь нет новой бизнес-логики — каждый паспорт проходит через тот же
 * `completeOperationByEmployee`, что и одиночный flow (см.
 * `passports-complete-operation.test.ts`). Поэтому фокус тестов — на
 * специфике пакета:
 *
 *   A. Все валидные паспорта закрываются разом: `completed` = N,
 *      `failed` = [], каждый получил `OPERATION_FINISHED`.
 *
 *   B. Партиальный успех: один паспорт-нарушитель (откат назад)
 *      не блокирует остальных — он попадает в `failed` с бизнес-кодом
 *      `PASSPORT_COMPLETE_BACKWARD`, а валидные всё равно закрываются.
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

describeWithDb('integration — passports.completeOperationsBatch', () => {
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
    };
  });

  const OP_BY_CODE = () =>
    ({
      CUT_DIVISION: seed.operations.CUT_DIVISION.id,
      SEW_OVERLOCK_1: seed.operations.SEW_OVERLOCK_1.id,
      SEW_OVERLOCK_2: seed.operations.SEW_OVERLOCK_2.id,
    }) as const;

  /**
   * Один заказ + snapshot маршрута CUT_DIVISION → SEW_OVERLOCK_1 →
   * SEW_OVERLOCK_2 → QC, одна швейная смена и N паспортов по спекам.
   * Возвращает id паспортов в порядке спеков.
   */
  async function setupBatch(opts: {
    shiftOperationCode: 'SEW_OVERLOCK_1' | 'SEW_OVERLOCK_2';
    passports: Array<{
      currentOperationCode: 'CUT_DIVISION' | 'SEW_OVERLOCK_1' | 'SEW_OVERLOCK_2';
      currentRouteStepIndex: number;
      /** По умолчанию — швея; задай другого, чтобы получить NOT_YOURS. */
      ownerId?: string;
    }>;
  }): Promise<string[]> {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: `O-BATCH-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 30 },
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
    const shiftOpId =
      opts.shiftOperationCode === 'SEW_OVERLOCK_1'
        ? seed.operations.SEW_OVERLOCK_1.id
        : seed.operations.SEW_OVERLOCK_2.id;
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: shiftOpId,
        startedAt: today,
      },
    });
    const opMap = OP_BY_CODE();
    const ids: string[] = [];
    for (const spec of opts.passports) {
      const suffix = Math.random().toString(36).slice(2, 8);
      const p = await t.prisma.passport.create({
        data: {
          number: `P-BATCH-${suffix}`,
          qrCode: `passport:batch-${suffix}`,
          orderId: order.id,
          productId: seed.product.id,
          sizeId: seed.sizes.M,
          color: 'Чёрный',
          rollNumber: 'R-BATCH',
          cutDate: today,
          qtyPlan: 6,
          qtyCut: 6,
          qtyGood: 6,
          cutterId: seed.employees.cutter.id,
          creatorId: seed.employees.cutter.id,
          status: 'IN_PROGRESS',
          currentOperationId: opMap[spec.currentOperationCode],
          currentEmployeeId: spec.ownerId ?? seed.employees.seamstress.id,
          currentRouteStepIndex: spec.currentRouteStepIndex,
        },
      });
      ids.push(p.id);
    }
    return ids;
  }

  // -------------------------------------------------------------------------
  // A. Все валидные паспорта закрываются разом
  // -------------------------------------------------------------------------

  test('A. пакет из 3 валидных паспортов закрывается весь: completed=3, failed=[]', async () => {
    const ids = await setupBatch({
      shiftOperationCode: 'SEW_OVERLOCK_1',
      passports: [
        { currentOperationCode: 'CUT_DIVISION', currentRouteStepIndex: 0 },
        { currentOperationCode: 'CUT_DIVISION', currentRouteStepIndex: 0 },
        { currentOperationCode: 'CUT_DIVISION', currentRouteStepIndex: 0 },
      ],
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/passports/batch/complete-operations')
      .set('Cookie', cookies.seamstress)
      .send({ passportIds: ids })
      .expect(201);

    expect(res.body.completed).toHaveLength(3);
    expect(res.body.failed).toHaveLength(0);
    expect(new Set(res.body.completed.map((c: { passportId: string }) => c.passportId)))
      .toEqual(new Set(ids));

    for (const id of ids) {
      const passport = await t.prisma.passport.findUniqueOrThrow({ where: { id } });
      expect(passport.currentEmployeeId).toBeNull();
      expect(passport.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
      expect(passport.currentRouteStepIndex).toBe(1);
      const events = await t.prisma.passportEvent.findMany({
        where: { passportId: id, type: 'OPERATION_FINISHED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.operationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    }
  });

  // -------------------------------------------------------------------------
  // B. Партиальный успех: нарушитель не блокирует остальных
  // -------------------------------------------------------------------------

  test('B. паспорт-нарушитель (откат назад) не блокирует пакет: completed=2, failed=1', async () => {
    // Два паспорта на idx 0 закроются на SEW_OVERLOCK_1 (forward), а
    // третий уже на SEW_OVERLOCK_2 (idx 2) — завершение его на смене
    // SEW_OVERLOCK_1 (idx 1) это backward → PASSPORT_COMPLETE_BACKWARD.
    const ids = await setupBatch({
      shiftOperationCode: 'SEW_OVERLOCK_1',
      passports: [
        { currentOperationCode: 'CUT_DIVISION', currentRouteStepIndex: 0 },
        { currentOperationCode: 'SEW_OVERLOCK_2', currentRouteStepIndex: 2 },
        { currentOperationCode: 'CUT_DIVISION', currentRouteStepIndex: 0 },
      ],
    });
    const [okA, backward, okB] = ids;

    const res = await request(t.app.getHttpServer())
      .post('/api/passports/batch/complete-operations')
      .set('Cookie', cookies.seamstress)
      .send({ passportIds: ids })
      .expect(201);

    expect(new Set(res.body.completed.map((c: { passportId: string }) => c.passportId)))
      .toEqual(new Set([okA, okB]));
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].passportId).toBe(backward);
    expect(res.body.failed[0].code).toBe('PASSPORT_COMPLETE_BACKWARD');
    expect(typeof res.body.failed[0].error).toBe('string');
    expect(res.body.failed[0].error.length).toBeGreaterThan(0);

    // Валидные — закрыты; нарушитель — не тронут.
    for (const id of [okA, okB]) {
      const passport = await t.prisma.passport.findUniqueOrThrow({ where: { id } });
      expect(passport.currentEmployeeId).toBeNull();
    }
    const stuck = await t.prisma.passport.findUniqueOrThrow({ where: { id: backward } });
    expect(stuck.currentEmployeeId).toBe(seed.employees.seamstress.id);
    expect(stuck.currentRouteStepIndex).toBe(2);
    const stuckEvents = await t.prisma.passportEvent.findMany({
      where: { passportId: backward, type: 'OPERATION_FINISHED' },
    });
    expect(stuckEvents).toHaveLength(0);
  });
});
