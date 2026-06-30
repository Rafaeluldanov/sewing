/**
 * Интеграционные тесты `GET /api/costs/passport/:id` — фактическая
 * себестоимость единицы паспорта (`PassportRealCostService`).
 *
 * Проверяем end-to-end на живых событиях:
 *   1) одиночный паспорт: материал(0) + сдельная(APPROVED) + оклад,
 *      где оклад = реальный интервал `ISSUED_TO_EMPLOYEE →
 *      OPERATION_FINISHED` × (salaryPerHour / 60);
 *   2) разнос оклада: один окладник держит ДВА паспорта одновременно
 *      10 минут → каждому достаётся ровно по 5 минут (деление 1/k);
 *   3) RBAC: рабочему роль не положена.
 *
 * Сетап делаем напрямую через prisma (как в `earnings-rbac.test.ts`) —
 * так суммы детерминированы и не зависят от полного API-флоу.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

// Почасовая ставка 600 ₽/ч / 60 = 10 ₽/мин — удобно для проверки
// (повременка; эквивалентно прежним 4800 ₽/смена / 480 мин).
const SALARY_PER_HOUR = 600;
const MINUTE_RATE = SALARY_PER_HOUR / 60; // = 10

// Фиксированная база времени (не Date.now) — сервис считает окно по
// датам самих событий, поэтому конкретная дата не важна, важна
// детерминированность.
const BASE = new Date('2026-06-10T08:00:00.000Z');
const at = (minutes: number): Date =>
  new Date(BASE.getTime() + minutes * 60_000);

describeWithDb('integration — себестоимость паспорта (факт)', () => {
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
    };
    // ОТК-сотрудник переводится на оклад.
    await t.prisma.employee.update({
      where: { id: seed.employees.qc.id },
      data: {
        compensationType: 'SALARY',
        salaryPerHour: new Prisma.Decimal(SALARY_PER_HOUR),
      },
    });
  });

  async function createOrder(number: string): Promise<string> {
    const order = await t.prisma.order.create({
      data: {
        number,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M,
            qtyPlan: 10,
          },
        },
      },
    });
    return order.id;
  }

  async function createPassport(
    orderId: string,
    number: string,
    qtyGood: number,
  ): Promise<string> {
    const p = await t.prisma.passport.create({
      data: {
        number,
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: `R-${number}`,
        cutDate: new Date(),
        qtyPlan: qtyGood,
        qtyCut: qtyGood,
        qtyGood,
        qrCode: `passport:${number}`,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
    return p.id;
  }

  // -------------------------------------------------------------------------
  // 1. Одиночный паспорт: сдельная + оклад по ISSUED→FINISHED
  // -------------------------------------------------------------------------
  test('сдельная + разнесённый оклад одного окладника', async () => {
    const orderId = await createOrder('O-COST-1');
    const passportId = await createPassport(orderId, 'P-COST-1', 10);

    // Сдельная (подтверждённая) на пошиве — 100 ₽.
    await t.prisma.operationEntry.create({
      data: {
        passportId,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 10,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(100),
        status: 'APPROVED',
        approvalMode: 'AFTER_RELEASE',
        sourceEventType: 'OPERATION_TRANSITION',
        approvedAt: new Date(),
      },
    });

    // ОТК держал паспорт ровно 6 минут (ISSUED → OPERATION_FINISHED).
    await t.prisma.passportEvent.createMany({
      data: [
        {
          passportId,
          type: 'ISSUED_TO_EMPLOYEE',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: at(0),
        },
        {
          passportId,
          type: 'OPERATION_FINISHED',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: at(6),
        },
      ],
    });

    const res = await request(t.app.getHttpServer())
      .get(`/api/costs/passport/${passportId}`)
      .set('Cookie', cookies.manager);

    expect(res.status).toBe(200);
    expect(res.body.qtyGood).toBe(10);
    expect(res.body.materialCost).toBe(0);
    expect(res.body.pieceworkCost).toBe(100);
    expect(res.body.salaryCost).toBeCloseTo(6 * MINUTE_RATE, 2); // 60
    expect(res.body.totalCost).toBeCloseTo(160, 2);
    expect(res.body.perUnitCost).toBeCloseTo(16, 2);

    expect(res.body.salaryLines).toHaveLength(1);
    const line = res.body.salaryLines[0];
    expect(line.minutes).toBeCloseTo(6, 1);
    expect(line.rub).toBeCloseTo(60, 2);
    expect(line.employeeName).toBe('Test QC');
    expect(line.operationName).toBe('ОТК');
  });

  // -------------------------------------------------------------------------
  // 2. Разнос оклада: два паспорта удерживаются одновременно
  // -------------------------------------------------------------------------
  test('оклад делится поровну между одновременно удерживаемыми паспортами', async () => {
    const orderId = await createOrder('O-COST-2');
    const passportA = await createPassport(orderId, 'P-COST-2A', 10);
    const passportB = await createPassport(orderId, 'P-COST-2B', 10);

    // ОТК взял оба в 08:00 и завершил оба в 08:10 → нахлёст 10 минут,
    // каждому паспорту достаётся по 5 минут.
    await t.prisma.passportEvent.createMany({
      data: [
        {
          passportId: passportA,
          type: 'ISSUED_TO_EMPLOYEE',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: at(0),
        },
        {
          passportId: passportB,
          type: 'ISSUED_TO_EMPLOYEE',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: at(0),
        },
        {
          passportId: passportA,
          type: 'OPERATION_FINISHED',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: at(10),
        },
        {
          passportId: passportB,
          type: 'OPERATION_FINISHED',
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          createdAt: at(10),
        },
      ],
    });

    const resA = await request(t.app.getHttpServer())
      .get(`/api/costs/passport/${passportA}`)
      .set('Cookie', cookies.manager);
    const resB = await request(t.app.getHttpServer())
      .get(`/api/costs/passport/${passportB}`)
      .set('Cookie', cookies.manager);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.salaryCost).toBeCloseTo(5 * MINUTE_RATE, 2); // 50
    expect(resB.body.salaryCost).toBeCloseTo(5 * MINUTE_RATE, 2); // 50
    expect(resA.body.salaryLines[0].minutes).toBeCloseTo(5, 1);
  });

  // -------------------------------------------------------------------------
  // 3. RBAC
  // -------------------------------------------------------------------------
  test('рабочей роли эндпоинт недоступен (403)', async () => {
    const orderId = await createOrder('O-COST-3');
    const passportId = await createPassport(orderId, 'P-COST-3', 10);
    const res = await request(t.app.getHttpServer())
      .get(`/api/costs/passport/${passportId}`)
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 4. Финализация снимка
  // -------------------------------------------------------------------------
  async function pack(passportId: string, packedAt: Date): Promise<void> {
    await t.prisma.passportEvent.create({
      data: {
        passportId,
        type: 'PACKED',
        operationId: seed.operations.PACKING.id,
        employeeId: seed.employees.packer.id,
        createdAt: packedAt,
      },
    });
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { status: 'PACKED' },
    });
  }

  test('до финализации — live (isFinal=false), после — FINAL и стабилен', async () => {
    const orderId = await createOrder('O-COST-4');
    const passportId = await createPassport(orderId, 'P-COST-4', 10);

    // Сдельная 100 ₽.
    await t.prisma.operationEntry.create({
      data: {
        passportId,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 10,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(100),
        status: 'APPROVED',
        approvalMode: 'AFTER_RELEASE',
        sourceEventType: 'OPERATION_TRANSITION',
        approvedAt: new Date(),
      },
    });
    // ОТК 6 минут (ISSUED→FINISHED) = 60 ₽ оклада; упаковка packer (сдельный) = 0.
    await t.prisma.passportEvent.createMany({
      data: [
        { passportId, type: 'ISSUED_TO_EMPLOYEE', operationId: seed.operations.QC.id, employeeId: seed.employees.qc.id, createdAt: at(0) },
        { passportId, type: 'OPERATION_FINISHED', operationId: seed.operations.QC.id, employeeId: seed.employees.qc.id, createdAt: at(6) },
      ],
    });
    await pack(passportId, at(30));

    // До финализации — live.
    const before = await request(t.app.getHttpServer())
      .get(`/api/costs/passport/${passportId}`)
      .set('Cookie', cookies.manager);
    expect(before.status).toBe(200);
    expect(before.body.isFinal).toBe(false);
    expect(before.body.finalizedAt).toBeNull();
    expect(before.body.totalCost).toBeCloseTo(160, 2); // 100 + 60 + 0

    // Финализация дня упаковки (2026-06-10, см. BASE).
    const fin = await request(t.app.getHttpServer())
      .post('/api/costs/snapshots/finalize')
      .query({ date: '2026-06-10' })
      .set('Cookie', cookies.manager);
    expect(fin.status).toBe(201);
    expect(fin.body.finalized).toBe(1);

    // После финализации — FINAL и стабилен, даже если добавить событие.
    await t.prisma.passportEvent.create({
      data: { passportId, type: 'OPERATION_FINISHED', operationId: seed.operations.QC.id, employeeId: seed.employees.qc.id, createdAt: at(50) },
    });
    const after = await request(t.app.getHttpServer())
      .get(`/api/costs/passport/${passportId}`)
      .set('Cookie', cookies.manager);
    expect(after.status).toBe(200);
    expect(after.body.isFinal).toBe(true);
    expect(after.body.finalizedAt).not.toBeNull();
    // Значение «застыло» на финализированном (новое событие его не сдвинуло).
    expect(after.body.totalCost).toBeCloseTo(160, 2);
    expect(after.body.salaryCost).toBeCloseTo(60, 2);
  });

  test('finalize недоступен рабочей роли (403)', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/costs/snapshots/finalize')
      .query({ date: '2026-06-10' })
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(403);
  });
});
