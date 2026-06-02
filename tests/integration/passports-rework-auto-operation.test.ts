/**
 * Integration-тест: авто-определение операции по паспорту, возвращённому
 * ОТК на переделку (см. `PassportsService.resolveOperationForPassport`,
 * инцидент 02.06.2026).
 *
 * Реальный кейс прод-цеха: распошивщица закрыла «Распошив рукав» (16),
 * ОТК вернул паспорт на переделку именно этой операции, а швея тем
 * временем переключилась на смену «РАСПОШИВ» (04). Раньше завершение
 * брало `OPERATION_FINISHED.operationId` строго из `session.operationId`
 * → паспорт нельзя было закрыть без ручного переключения смены обратно,
 * и он «висел» в «К переделке».
 *
 * Здесь моделируем на seed-операциях (один оверлок `overlock-01`
 * разрешает обе sewing-операции, ADR-0017):
 *   - шаг переделки  = `SEW_OVERLOCK_2` (аналог «16 Распошив рукав»);
 *   - смена швеи     = `SEW_OVERLOCK_1` (аналог «04 РАСПОШИВ»).
 *
 * Проверяем:
 *   1. complete со «смены не на той операции» закрывает rework: пишет
 *      `OPERATION_FINISHED` на операцию ПЕРЕДЕЛКИ (а не смены), паспорт
 *      уходит из `/shifts/my-rework`;
 *   2. end-to-end через issue (как из секции «К переделке» на /work):
 *      «Принять» + «Завершить» закрывают rework на нужной операции;
 *   3. если операция переделки НЕ разрешена на оборудовании смены —
 *      409 PASSPORT_REWORK_OPERATION_NOT_ALLOWED_FOR_SHIFT, состояние
 *      паспорта не меняется.
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

describeWithDb('integration — rework auto-operation by passport', () => {
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
    cookies = { seamstress: loginAs(t, seed.employees['seamstress']) };
  });

  /**
   * Заказ с маршрутом CUT_DIVISION → OVERLOCK_1 → OVERLOCK_2 → QC, смена
   * швеи на `shiftOperationCode` (станок по умолчанию `overlock-01`,
   * разрешает обе) и паспорт, у которого ОТК открыл переделку на
   * `reworkOperationCode`. Паспорт стоит на шаге переделки.
   *
   * `assignToSeamstress` — закреплять ли паспорт за швеёй сразу
   * (имитирует уже принятый крой; complete можно звать без issue).
   */
  async function setupReworkedPassport(opts: {
    shiftOperationCode: 'SEW_OVERLOCK_1' | 'SEW_OVERLOCK_2';
    reworkOperationCode: 'SEW_OVERLOCK_1' | 'SEW_OVERLOCK_2';
    assignToSeamstress: boolean;
    shiftEquipmentId?: string;
  }): Promise<{ passportId: string; reworkOpId: string }> {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: `O-RW-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 6 },
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
    const shiftOpId = seed.operations[opts.shiftOperationCode].id;
    const reworkOpId = seed.operations[opts.reworkOperationCode].id;
    const reworkStepIndex = opts.reworkOperationCode === 'SEW_OVERLOCK_1' ? 1 : 2;

    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: opts.shiftEquipmentId ?? seed.equipment['overlock-01'].id,
        operationId: shiftOpId,
        startedAt: today,
      },
    });

    const passport = await t.prisma.passport.create({
      data: {
        number: `P-RW-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:rw-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-RW',
        cutDate: today,
        qtyPlan: 6,
        qtyCut: 6,
        qtyGood: 6,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        // После returnToRework паспорт стоит на шаге переделки.
        currentOperationId: reworkOpId,
        currentRouteStepIndex: reworkStepIndex,
        currentEmployeeId: opts.assignToSeamstress
          ? seed.employees.seamstress.id
          : null,
      },
    });

    // Прошлый проход операции + открытый возврат ОТК на неё. Порядок по
    // времени: FINISHED раньше, REWORK_OPENED позже (без последующего
    // FINISHED — значит rework «открыт»). Финишёр/получатель — швея.
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'OPERATION_FINISHED',
        employeeId: seed.employees.seamstress.id,
        operationId: reworkOpId,
        qty: 6,
        createdAt: new Date(Date.now() - 120_000),
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'OPERATION_REWORK_OPENED',
        employeeId: seed.employees.seamstress.id,
        operationId: reworkOpId,
        qty: 6,
        createdAt: new Date(Date.now() - 60_000),
      },
    });

    return { passportId: passport.id, reworkOpId };
  }

  test('1. complete со смены «не на той операции» закрывает rework на операции ПЕРЕДЕЛКИ', async () => {
    const { passportId, reworkOpId } = await setupReworkedPassport({
      shiftOperationCode: 'SEW_OVERLOCK_1', // смена «РАСПОШИВ»
      reworkOperationCode: 'SEW_OVERLOCK_2', // ОТК вернул «Распошив рукав»
      assignToSeamstress: true,
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // OPERATION_FINISHED записан на операцию ПЕРЕДЕЛКИ (OVERLOCK_2),
    // а не на операцию смены (OVERLOCK_1).
    const finished = await t.prisma.passportEvent.findFirst({
      where: { passportId, type: 'OPERATION_FINISHED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(finished?.operationId).toBe(reworkOpId);
    expect(finished?.operationId).toBe(seed.operations.SEW_OVERLOCK_2.id);
    expect(finished?.operationId).not.toBe(seed.operations.SEW_OVERLOCK_1.id);

    // Паспорт встал на завершённую операцию переделки и освободился.
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_2.id);
    expect(passport.currentEmployeeId).toBeNull();

    // rework закрыт → паспорт ушёл из «К переделке».
    const rework = await request(t.app.getHttpServer())
      .get('/api/shifts/my-rework')
      .set('Cookie', cookies.seamstress)
      .expect(200);
    expect(
      (rework.body as Array<{ passportId: string }>).some(
        (r) => r.passportId === passportId,
      ),
    ).toBe(false);
  });

  test('2. end-to-end через issue+complete закрывает rework (как из «К переделке»)', async () => {
    const { passportId } = await setupReworkedPassport({
      shiftOperationCode: 'SEW_OVERLOCK_1',
      reworkOperationCode: 'SEW_OVERLOCK_2',
      assignToSeamstress: false, // returnToRework освобождает паспорт
    });

    // «Принять» из секции «К переделке» = обычный issue.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // issue уже атрибутировал паспорт операции переделки.
    const afterIssue = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(afterIssue.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_2.id);
    expect(afterIssue.currentEmployeeId).toBe(seed.employees.seamstress.id);

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const finished = await t.prisma.passportEvent.findFirst({
      where: { passportId, type: 'OPERATION_FINISHED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(finished?.operationId).toBe(seed.operations.SEW_OVERLOCK_2.id);
  });

  test('3. операция переделки не разрешена на оборудовании смены → 409', async () => {
    // Отдельный станок, на котором разрешён ТОЛЬКО OVERLOCK_1.
    const limited = await t.prisma.equipment.create({
      data: {
        code: `overlock-limited-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `equipment:lim-${Math.random().toString(36).slice(2, 8)}`,
        name: 'Оверлок (ограниченный)',
        allowedOperations: {
          create: [
            { operationId: seed.operations.SEW_OVERLOCK_1.id, isActive: true },
          ],
        },
      },
    });

    const { passportId } = await setupReworkedPassport({
      shiftOperationCode: 'SEW_OVERLOCK_1',
      reworkOperationCode: 'SEW_OVERLOCK_2', // НЕ разрешена на `limited`
      assignToSeamstress: true,
      shiftEquipmentId: limited.id,
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body.code).toBe('PASSPORT_REWORK_OPERATION_NOT_ALLOWED_FOR_SHIFT');

    // Паспорт не тронут: ни FINISHED после rework, ни смены состояния.
    const finishedAfterRework = await t.prisma.passportEvent.findFirst({
      where: {
        passportId,
        type: 'OPERATION_FINISHED',
        createdAt: { gt: new Date(Date.now() - 60_000) },
      },
    });
    expect(finishedAfterRework).toBeNull();
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.currentEmployeeId).toBe(seed.employees.seamstress.id);
  });
});
