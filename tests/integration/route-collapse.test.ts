/**
 * Integration-тест автосворачивания сплит-маршрута распошива.
 *
 * Гоняет РЕАЛЬНЫЙ `PassportsService.completeOperationByEmployee` (с хуком
 * `maybeCollapseSplitRoute` внутри транзакции) против тестовой БД и
 * проверяет, что:
 *   1. когда низ закрывается на рукавном станке и больше никто не держит
 *      низ отдельно — `OrderRouteStep` заказа сворачивается (пара
 *      рукав+низ → один полный распошив), а паспорта переиндексируются;
 *   2. пока второй станок ещё держит низ отдельно — сворачивания нет.
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

  test('низ закрыт на рукавном станке, никто не держит низ → маршрут свёрнут', async () => {
    const { prisma, passports, ops, sleeveStationId } = ctx;
    const seamstressId = ctx.t.prisma
      ? (await prisma.employee.findFirstOrThrow({ where: { login: 'seamstress' } })).id
      : '';
    const orderId = await makeSplitOrder(`O-${SUFFIX}-A`);
    // Паспорт стоит на низе, держит швея, чья смена — на рукавном станке.
    const passportId = await makePassport(orderId, `P-${SUFFIX}-A1`, {
      currentOperationId: ops.low,
      currentRouteStepIndex: 3,
      currentEmployeeId: seamstressId,
    });
    await openShift(seamstressId, sleeveStationId, ops.low);

    await passports.completeOperationByEmployee(passportId, seamstressId);

    const steps = await prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
    });
    const stepOps = steps.map((s) => s.operationId);
    expect(stepOps).not.toContain(ops.sleeve);
    expect(stepOps).not.toContain(ops.low);
    expect(stepOps).toContain(ops.full);

    const target = steps.find((s) => s.operationId === ops.full)!;
    expect(target.index).toBe(2); // минимальный освободившийся merge-индекс
    expect(target.parallelGroup).toBe(2); // киперка осталась параллельной

    const p = await prisma.passport.findUniqueOrThrow({ where: { id: passportId } });
    expect(p.currentOperationId).toBe(ops.full);
    expect(p.currentRouteStepIndex).toBe(2);
  });

  test('второй станок ещё держит низ отдельно → маршрут НЕ свёрнут', async () => {
    const { prisma, passports, ops, sleeveStationId, lowStationId } = ctx;
    const seamstressId = (await prisma.employee.findFirstOrThrow({ where: { login: 'seamstress' } })).id;
    // Вторая швея на выделенном низ-станке.
    const seamstress2 = await prisma.employee.upsert({
      where: { login: `seamstress2-${SUFFIX}` },
      create: { login: `seamstress2-${SUFFIX}`, fullName: 'Seamstress 2', role: 'SEAMSTRESS', active: true, pinHash: 'x' },
      update: {},
    });

    const orderId = await makeSplitOrder(`O-${SUFFIX}-B`);
    const crossPassport = await makePassport(orderId, `P-${SUFFIX}-B1`, {
      currentOperationId: ops.low,
      currentRouteStepIndex: 3,
      currentEmployeeId: seamstressId,
    });
    // Второй паспорт держит вторая швея на низ-станке (низ ещё идёт отдельно).
    await makePassport(orderId, `P-${SUFFIX}-B2`, {
      currentOperationId: ops.low,
      currentRouteStepIndex: 3,
      currentEmployeeId: seamstress2.id,
    });
    await openShift(seamstressId, sleeveStationId, ops.low);
    await openShift(seamstress2.id, lowStationId, ops.low);

    await passports.completeOperationByEmployee(crossPassport, seamstressId);

    const steps = await prisma.orderRouteStep.findMany({ where: { orderId } });
    const stepOps = steps.map((s) => s.operationId);
    // Сплит сохранён: рукав и низ на месте, полного распошива нет.
    expect(stepOps).toContain(ops.sleeve);
    expect(stepOps).toContain(ops.low);
    expect(stepOps).not.toContain(ops.full);
  });
});
