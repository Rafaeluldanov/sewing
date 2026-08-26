/**
 * Integration-тест: операцию ВЗЯТИЯ задаёт маршрут ПАСПОРТА, а не то,
 * что швея выбрала при открытии смены (см.
 * `PassportsService.resolveOperationByPassportRoute`, инцидент
 * 15.08.2026, заказ 02-00001).
 *
 * Реальный кейс прод-цеха: станок ОВЕРЛОК привязан сразу к двум
 * операциям-двойникам — `02 Ф ОВЕРЛОК` и `098642 ОВЕРЛОК`. В маршруте
 * заказа стоит вторая, смена была открыта на первой, гейт работы вне
 * маршрута стоит в `WARN` — и паспорт молча ушёл на операцию, которой
 * в маршруте нет: сделка легла по чужой расценке, а шаг маршрута
 * пришлось проходить заново неделю спустя (разбор —
 * `scripts/migrations/20260826_drop_offroute_f_overlock_02-00001.sql`).
 *
 * Здесь моделируем на seed-е: станок `overlock-01` разрешает обе
 * швейные операции (ADR-0017), в маршруте заказа стоит только
 * `SEW_OVERLOCK_1`, а смена открыта на `SEW_OVERLOCK_2`.
 *
 * Проверяем:
 *   1. issue со «смены не по маршруту» ставит паспорт на операцию
 *      МАРШРУТА, пишет `PASSPORT_OPERATION_ROUTED` в аудит, и
 *      последующий complete закрывает ровно её;
 *   2. если оборудование смены не умеет ни одной операции маршрута —
 *      409 `PASSPORT_SHIFT_OPERATION_NOT_ON_ROUTE`, паспорт не тронут;
 *   3. смена на операции ИЗ маршрута — прежнее поведение, подстановки
 *      и аудита нет;
 *   4. узаконенная замена (`OperationSubstitution`) подстановкой НЕ
 *      считается: операция-заместитель остаётся той, на которой стоит
 *      смена.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — issue operation by passport route', () => {
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
   * Заказ с маршрутом CUT_DIVISION → SEW_OVERLOCK_1 → QC, смена швеи на
   * `shiftOperationCode` и свободный паспорт, стоящий на шаге кроя
   * (`currentRouteStepIndex = 0`) — ровно то состояние, в котором швея
   * забирает разделённый крой.
   *
   * `status = IN_PROGRESS` (а не `CREATED`) — чтобы не задевать гейт
   * размещения в ячейке (`assertPlacedBeforeLeavingCut`): здесь
   * проверяется выбор операции, а не буферизация кроя.
   */
  async function setupPassport(opts: {
    shiftOperationCode: 'SEW_OVERLOCK_1' | 'SEW_OVERLOCK_2';
    shiftEquipmentId?: string;
  }): Promise<{ passportId: string; orderId: string }> {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: `O-RT-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: today,
        color: 'Синий',
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
        {
          orderId: order.id,
          index: 0,
          operationId: seed.operations.CUT_DIVISION.id,
        },
        {
          orderId: order.id,
          index: 1,
          operationId: seed.operations.SEW_OVERLOCK_1.id,
        },
        { orderId: order.id, index: 2, operationId: seed.operations.QC.id },
      ],
    });

    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: opts.shiftEquipmentId ?? seed.equipment['overlock-01'].id,
        operationId: seed.operations[opts.shiftOperationCode].id,
        startedAt: today,
      },
    });

    const passport = await t.prisma.passport.create({
      data: {
        number: `P-RT-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:rt-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Синий',
        rollNumber: 'R-RT',
        cutDate: today,
        qtyPlan: 6,
        qtyCut: 6,
        qtyGood: 6,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.CUT_DIVISION.id,
        currentRouteStepIndex: 0,
        currentEmployeeId: null,
      },
    });
    return { passportId: passport.id, orderId: order.id };
  }

  test('1. смена вне маршрута → паспорт встаёт на операцию МАРШРУТА', async () => {
    const { passportId } = await setupPassport({
      shiftOperationCode: 'SEW_OVERLOCK_2', // в маршруте заказа её нет
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const afterIssue = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(afterIssue.currentOperationId).toBe(
      seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(afterIssue.currentOperationId).not.toBe(
      seed.operations.SEW_OVERLOCK_2.id,
    );
    expect(afterIssue.currentEmployeeId).toBe(seed.employees.seamstress.id);

    const issued = await t.prisma.passportEvent.findFirst({
      where: { passportId, type: 'ISSUED_TO_EMPLOYEE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(issued?.operationId).toBe(seed.operations.SEW_OVERLOCK_1.id);

    // Подстановка не молчаливая — остаётся след для разбора.
    const audit = await t.prisma.auditLog.findFirst({
      where: { event: 'PASSPORT_OPERATION_ROUTED', entityId: passportId },
    });
    expect(audit).not.toBeNull();

    // Завершение закрывает то, НА ЧТО паспорт взят, а не операцию смены
    // (смена всё это время стоит на SEW_OVERLOCK_2).
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const finished = await t.prisma.passportEvent.findFirst({
      where: { passportId, type: 'OPERATION_FINISHED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(finished?.operationId).toBe(seed.operations.SEW_OVERLOCK_1.id);

    // И сделка легла на маршрутную операцию — ровно то, что 15.08 ушло
    // на чужую расценку.
    const entry = await t.prisma.operationEntry.findFirst({
      where: { passportId },
    });
    expect(entry?.operationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
  });

  test('2. оборудование не умеет ни одной операции маршрута → 409', async () => {
    // Станок, на котором разрешена ТОЛЬКО внемаршрутная операция.
    const limited = await t.prisma.equipment.create({
      data: {
        code: `overlock-limited-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `equipment:lim-${Math.random().toString(36).slice(2, 8)}`,
        name: 'Оверлок (ограниченный)',
        allowedOperations: {
          create: [
            { operationId: seed.operations.SEW_OVERLOCK_2.id, isActive: true },
          ],
        },
      },
    });

    const { passportId } = await setupPassport({
      shiftOperationCode: 'SEW_OVERLOCK_2',
      shiftEquipmentId: limited.id,
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect((res.body as { code?: string }).code).toBe(
      'PASSPORT_SHIFT_OPERATION_NOT_ON_ROUTE',
    );

    // Паспорт не тронут: ни владельца, ни переезда на чужую операцию.
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.currentOperationId).toBe(seed.operations.CUT_DIVISION.id);
    expect(passport.currentEmployeeId).toBeNull();
    expect(
      await t.prisma.passportEvent.count({
        where: { passportId, type: 'ISSUED_TO_EMPLOYEE' },
      }),
    ).toBe(0);
  });

  test('3. смена на операции ИЗ маршрута → прежнее поведение', async () => {
    const { passportId } = await setupPassport({
      shiftOperationCode: 'SEW_OVERLOCK_1', // шаг 1 маршрута
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(
      await t.prisma.auditLog.count({
        where: { event: 'PASSPORT_OPERATION_ROUTED', entityId: passportId },
      }),
    ).toBe(0);
  });

  test('4. узаконенная замена операции не подменяется маршрутом', async () => {
    // OVERLOCK_2 официально закрывает OVERLOCK_1 (сценарий «сломался
    // станок, операцию закрывает соседняя» — `OperationSubstitution`).
    await t.prisma.operationSubstitution.create({
      data: {
        substituteOpId: seed.operations.SEW_OVERLOCK_2.id,
        satisfiesOpId: seed.operations.SEW_OVERLOCK_1.id,
      },
    });

    const { passportId } = await setupPassport({
      shiftOperationCode: 'SEW_OVERLOCK_2',
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // Замена законна → операция смены остаётся, подстановки нет.
    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.currentOperationId).toBe(seed.operations.SEW_OVERLOCK_2.id);
    expect(
      await t.prisma.auditLog.count({
        where: { event: 'PASSPORT_OPERATION_ROUTED', entityId: passportId },
      }),
    ).toBe(0);
  });
});
