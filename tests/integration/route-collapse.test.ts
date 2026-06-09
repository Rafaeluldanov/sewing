/**
 * Integration-тест адаптивного сплит-распошива (Вариант B, см. route-mode.ts).
 *
 * Необратимое сворачивание снапшота маршрута УДАЛЕНО. Теперь снимок всегда
 * остаётся сплитом, а полный распошив (04) засчитывается через
 * `OperationSubstitution`. Гоняет РЕАЛЬНЫЙ
 * `PassportsService.completeOperationByEmployee` против тестовой БД и
 * проверяет, что:
 *   1. закрытие полного распошива (04) на сплит-снимке НЕ меняет
 *      `OrderRouteStep` заказа, но корректно позиционирует паспорт по
 *      распошив-группе (substitution-aware индексация: паспорт встаёт на
 *      максимальный индекс merge-группы, операция = 04);
 *   2. снимок маршрута никогда не сворачивается, сколько бы паспортов ни
 *      закрыли распошив через 04.
 *
 * Запускается только при заданном `TEST_DATABASE_URL` (см.
 * `tests/utils/db.ts`); иначе сьют тихо skip-ается.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Prisma, PassportStatus, type PrismaClient } from '@prisma/client';
import { describeWithDb } from '../utils/db.js';
import { startTestApp, stopTestApp, type TestApp } from '../utils/app.js';
import { seedMinimal } from '../utils/seed.js';
import { PassportsService } from '@sewing/api/modules/passports/passports.service';

const SUFFIX = `rc-${Date.now()}`;

interface Ctx {
  t: TestApp;
  prisma: PrismaClient;
  passports: PassportsService;
  ops: { kiperka: string; sleeve: string; low: string; full: string; qc: string };
  sleeveStationId: string;
  lowStationId: string;
  productId: string;
  sizeId: string;
  cutterId: string;
}

let ctx: Ctx;

async function ensureOp(
  prisma: PrismaClient,
  code: string,
  name: string,
): Promise<string> {
  const row = await prisma.operation.upsert({
    where: { code },
    create: {
      code,
      name,
      category: 'SEWING',
      sortOrder: 110,
      active: true,
      pricingMode: 'FIXED',
      fixedRate: new Prisma.Decimal(10),
    },
    update: { name, active: true },
  });
  return row.id;
}

async function ensureEquip(
  prisma: PrismaClient,
  code: string,
  allowedOps: string[],
): Promise<string> {
  const eq = await prisma.equipment.upsert({
    where: { code },
    create: { code, name: code, qrCode: `equipment:${code}`, active: true },
    update: { active: true },
  });
  for (const operationId of allowedOps) {
    await prisma.equipmentOperation.upsert({
      where: {
        EquipmentOperation_equipment_operation_uniq: {
          equipmentId: eq.id,
          operationId,
        },
      },
      create: { equipmentId: eq.id, operationId, isActive: true },
      update: { isActive: true },
    });
  }
  return eq.id;
}

/** Создаёт заказ со сплит-маршрутом крой→[киперка∥рукав∥низ]→ОТК. */
async function makeSplitOrder(orderNum: string): Promise<string> {
  const { prisma, ops } = ctx;
  const order = await prisma.order.create({
    data: { number: orderNum, orderDate: new Date(), status: 'IN_PRODUCTION' },
  });
  await prisma.orderRouteStep.createMany({
    data: [
      { orderId: order.id, index: 1, operationId: ops.kiperka, parallelGroup: 2 },
      { orderId: order.id, index: 2, operationId: ops.sleeve, parallelGroup: 2 },
      { orderId: order.id, index: 3, operationId: ops.low, parallelGroup: 2 },
      { orderId: order.id, index: 4, operationId: ops.qc, parallelGroup: null },
    ],
  });
  return order.id;
}

async function makePassport(
  orderId: string,
  num: string,
  data: {
    currentOperationId: string;
    currentRouteStepIndex: number;
    currentEmployeeId: string | null;
  },
): Promise<string> {
  const { prisma, productId, sizeId, cutterId } = ctx;
  const p = await prisma.passport.create({
    data: {
      number: num,
      qrCode: `passport:${num}`,
      orderId,
      productId,
      sizeId,
      color: 'Чёрный',
      rollNumber: '1',
      cutDate: new Date(),
      qtyPlan: 10,
      qtyCut: 10,
      qtyGood: 10,
      status: PassportStatus.IN_PROGRESS,
      cutterId,
      creatorId: cutterId,
      ...data,
    },
  });
  return p.id;
}

/** Открывает смену сотруднику на станке/операции (закрыв прежние). */
async function openShift(
  employeeId: string,
  equipmentId: string,
  operationId: string,
): Promise<void> {
  const { prisma } = ctx;
  await prisma.shiftSession.updateMany({
    where: { employeeId, endedAt: null },
    data: { endedAt: new Date() },
  });
  await prisma.shiftSession.create({
    data: { employeeId, equipmentId, operationId },
  });
}

describeWithDb('split-route collapse (integration)', () => {
  beforeAll(async () => {
    const t = await startTestApp();
    const prisma = t.prisma as unknown as PrismaClient;
    const seed = await seedMinimal(prisma);
    const passports = t.app.get(PassportsService);

    const kiperka = await ensureOp(prisma, `03-${SUFFIX}`, 'Киперка (test)');
    const sleeve = await ensureOp(prisma, `16-${SUFFIX}`, 'Распошив рукав (test)');
    const low = await ensureOp(prisma, `0001-${SUFFIX}`, 'Подгиб низа (test)');
    const full = await ensureOp(prisma, `04-${SUFFIX}`, 'Распошив (test)');
    const qc = seed.operations.QC.id;

    // Substitution: 04 закрывает и низ, и рукав; рукав — принимающая станция.
    await prisma.operationSubstitution.upsert({
      where: { satisfiesOpId_substituteOpId: { satisfiesOpId: low, substituteOpId: full } },
      create: { satisfiesOpId: low, substituteOpId: full, isReceivingStation: false },
      update: { isReceivingStation: false },
    });
    await prisma.operationSubstitution.upsert({
      where: { satisfiesOpId_substituteOpId: { satisfiesOpId: sleeve, substituteOpId: full } },
      create: { satisfiesOpId: sleeve, substituteOpId: full, isReceivingStation: true },
      update: { isReceivingStation: true },
    });

    // Рукавный станок умеет рукав+полный распошив (+ может закрыть и низ);
    // выделенный низ-станок умеет только низ.
    const sleeveStationId = await ensureEquip(prisma, `sleeve-${SUFFIX}`, [sleeve, full, low]);
    const lowStationId = await ensureEquip(prisma, `low-${SUFFIX}`, [low]);

    ctx = {
      t,
      prisma,
      passports,
      ops: { kiperka, sleeve, low, full, qc },
      sleeveStationId,
      lowStationId,
      productId: seed.product.id,
      sizeId: seed.sizes.M,
      cutterId: seed.employees.cutter.id,
    };
  });

  afterAll(async () => {
    if (ctx?.t) await stopTestApp(ctx.t);
  });

  test('полный распошив (04) на сплит-снимке: маршрут НЕ сворачивается, паспорт встаёт на распошив-группу', async () => {
    const { prisma, passports, ops, sleeveStationId } = ctx;
    const seamstressId = (await prisma.employee.findFirstOrThrow({ where: { login: 'seamstress' } })).id;
    const orderId = await makeSplitOrder(`O-${SUFFIX}-A`);
    // Паспорт стоит на низе; швея закрывает его полным распошивом (04) на
    // рукав-способном станке (смена на операции 04).
    const passportId = await makePassport(orderId, `P-${SUFFIX}-A1`, {
      currentOperationId: ops.low,
      currentRouteStepIndex: 3,
      currentEmployeeId: seamstressId,
    });
    await openShift(seamstressId, sleeveStationId, ops.full);

    await passports.completeOperationByEmployee(passportId, seamstressId);

    // Снимок маршрута НЕ изменился: рукав и низ на месте, полного нет.
    const steps = await prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    const stepOps = steps.map((s) => s.operationId);
    expect(stepOps).toContain(ops.sleeve);
    expect(stepOps).toContain(ops.low);
    expect(stepOps).not.toContain(ops.full);

    // Substitution-aware индексация: паспорт встал на максимальный индекс
    // merge-группы (низ idx3 > рукав idx2), операция = полный распошив 04.
    const p = await prisma.passport.findUniqueOrThrow({ where: { id: passportId } });
    expect(p.currentOperationId).toBe(ops.full);
    expect(p.currentRouteStepIndex).toBe(3);

    // Закрытие записано как OPERATION_FINISHED по 04 (засчитывает низ+рукав).
    const finished = await prisma.passportEvent.findFirst({
      where: { passportId, type: 'OPERATION_FINISHED', operationId: ops.full },
    });
    expect(finished).not.toBeNull();
  });

  test('сколько бы паспортов ни закрыли распошив через 04 — снимок остаётся сплитом', async () => {
    const { prisma, passports, ops, sleeveStationId } = ctx;
    const seamstressId = (await prisma.employee.findFirstOrThrow({ where: { login: 'seamstress' } })).id;
    const orderId = await makeSplitOrder(`O-${SUFFIX}-B`);

    for (const n of [1, 2, 3]) {
      const pid = await makePassport(orderId, `P-${SUFFIX}-B${n}`, {
        currentOperationId: ops.low,
        currentRouteStepIndex: 3,
        currentEmployeeId: seamstressId,
      });
      await openShift(seamstressId, sleeveStationId, ops.full);
      await passports.completeOperationByEmployee(pid, seamstressId);
    }

    const steps = await prisma.orderRouteStep.findMany({ where: { orderId } });
    const stepOps = steps.map((s) => s.operationId);
    // Сплит сохранён независимо от числа закрытий через 04.
    expect(stepOps).toContain(ops.sleeve);
    expect(stepOps).toContain(ops.low);
    expect(stepOps).not.toContain(ops.full);
  });
});
