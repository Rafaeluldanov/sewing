/**
 * Integration-тест адаптивного режима сплит-распошива на МОНИТОРЕ ЦЕХА
 * (Вариант B, см. apps/api/src/modules/passports/route-mode.ts).
 *
 * Проверяет сквозь РЕАЛЬНЫЙ `ShopfloorService.getDisplaySummary` против
 * тестовой БД, что колонки распошива в `sewingRoute` адаптивно
 * раздваиваются/схлопываются:
 *   1. нет активной смены на выделенном низ-станке → COLLAPSED: одна
 *      колонка «полный распошив» (04), отдельных низ/рукав НЕТ;
 *   2. открыли смену на выделенном низ-станке (podgib-niza, умеет только
 *      0001) → SPLIT: две колонки (Подгиб низа 0001 + Распошив рукав 16),
 *      слитой 04 НЕТ;
 *   3. закрыли смену → снова COLLAPSED;
 *   4. FORCE_SPLIT override держит две колонки даже без активной низ-смены.
 *
 * Снапшот OrderRouteStep при этом НЕ меняется ни разу — режим производный.
 *
 * Запускается только при заданном `TEST_DATABASE_URL` (см.
 * `tests/utils/db.ts`); иначе сьют тихо skip-ается.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Prisma, PassportStatus, type PrismaClient } from '@prisma/client';
import { describeWithDb } from '../utils/db.js';
import { startTestApp, stopTestApp, type TestApp } from '../utils/app.js';
import { seedMinimal } from '../utils/seed.js';
import { ShopfloorService } from '@sewing/api/modules/shopfloor/shopfloor.service';

const SUFFIX = `rmm-${Date.now()}`;

interface Ctx {
  t: TestApp;
  prisma: PrismaClient;
  shopfloor: ShopfloorService;
  orderId: string;
  ops: { kiperka: string; sleeve: string; low: string; full: string };
  lowStationId: string;
  seamstressId: string;
}
let ctx: Ctx;

async function ensureOp(prisma: PrismaClient, code: string, name: string): Promise<string> {
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

async function ensureEquip(prisma: PrismaClient, code: string, allowedOps: string[]): Promise<string> {
  const eq = await prisma.equipment.upsert({
    where: { code },
    create: { code, name: code, qrCode: `equipment:${code}`, active: true },
    update: { active: true },
  });
  for (const operationId of allowedOps) {
    await prisma.equipmentOperation.upsert({
      where: { EquipmentOperation_equipment_operation_uniq: { equipmentId: eq.id, operationId } },
      create: { equipmentId: eq.id, operationId, isActive: true },
      update: { isActive: true },
    });
  }
  return eq.id;
}

/** Операции распошива (04/0001/16), реально присутствующие в sewingRoute. */
async function sewingOpIds(): Promise<Set<string>> {
  const display = await ctx.shopfloor.getDisplaySummary();
  return new Set(display.sewingRoute.map((b) => b.operationId));
}

describeWithDb('split-route adaptive mode on monitor (integration)', () => {
  beforeAll(async () => {
    const t = await startTestApp();
    const prisma = t.prisma as unknown as PrismaClient;
    const seed = await seedMinimal(prisma);
    const shopfloor = t.app.get(ShopfloorService);

    const kiperka = await ensureOp(prisma, `03-${SUFFIX}`, 'Киперка (test)');
    const sleeve = await ensureOp(prisma, `16-${SUFFIX}`, 'Распошив рукав (test)');
    const low = await ensureOp(prisma, `0001-${SUFFIX}`, 'Подгиб низа (test)');
    const full = await ensureOp(prisma, `04-${SUFFIX}`, 'Распошив (test)');
    const qc = seed.operations.QC.id;

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

    // Универсальный распошивной станок (рукав+полный+низ) и ВЫДЕЛЕННЫЙ
    // низ-станок (умеет только 0001) — единственный сигнал SPLIT.
    await ensureEquip(prisma, `rasposhiv-${SUFFIX}`, [sleeve, full, low]);
    const lowStationId = await ensureEquip(prisma, `podgib-${SUFFIX}`, [low]);

    // Заказ со сплит-снимком: крой(SEWING)→[киперка∥низ∥рукав]→ОТК.
    const order = await prisma.order.create({
      data: { number: `O-${SUFFIX}`, orderDate: new Date(), status: 'IN_PRODUCTION' },
    });
    await prisma.orderRouteStep.createMany({
      data: [
        { orderId: order.id, index: 1, operationId: kiperka, parallelGroup: 2 },
        { orderId: order.id, index: 2, operationId: low, parallelGroup: 2 },
        { orderId: order.id, index: 3, operationId: sleeve, parallelGroup: 2 },
        { orderId: order.id, index: 4, operationId: qc, parallelGroup: null },
      ],
    });

    const seamstressId = (await prisma.employee.findFirstOrThrow({ where: { login: 'seamstress' } })).id;
    // Один паспорт в распошиве — чтобы у колонок были данные.
    await prisma.passport.create({
      data: {
        number: `P-${SUFFIX}-1`,
        qrCode: `passport:${SUFFIX}-1`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: '1',
        cutDate: new Date(),
        qtyPlan: 10,
        qtyCut: 10,
        qtyGood: 10,
        status: PassportStatus.IN_PROGRESS,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        currentOperationId: low,
        currentRouteStepIndex: 2,
        currentEmployeeId: seamstressId,
      },
    });

    ctx = {
      t,
      prisma,
      shopfloor,
      orderId: order.id,
      ops: { kiperka, sleeve, low, full },
      lowStationId,
      seamstressId,
    };
  });

  afterAll(async () => {
    if (ctx?.t) await stopTestApp(ctx.t);
  });

  async function setOverride(value: 'AUTO' | 'FORCE_SPLIT' | 'FORCE_COLLAPSED'): Promise<void> {
    await ctx.prisma.order.update({
      where: { id: ctx.orderId },
      data: { routeModeOverride: value },
    });
  }

  async function closeLowShifts(): Promise<void> {
    await ctx.prisma.shiftSession.updateMany({
      where: { employeeId: ctx.seamstressId, endedAt: null },
      data: { endedAt: new Date() },
    });
  }

  test('AUTO без активной низ-смены → COLLAPSED: одна колонка 04, без 0001/16', async () => {
    await setOverride('AUTO');
    await closeLowShifts();
    const ids = await sewingOpIds();
    expect(ids.has(ctx.ops.full)).toBe(true);
    expect(ids.has(ctx.ops.low)).toBe(false);
    expect(ids.has(ctx.ops.sleeve)).toBe(false);
  });

  test('AUTO + смена на выделенном низ-станке → SPLIT: 0001 и 16, без слитой 04', async () => {
    await setOverride('AUTO');
    await closeLowShifts();
    await ctx.prisma.shiftSession.create({
      data: { employeeId: ctx.seamstressId, equipmentId: ctx.lowStationId, operationId: ctx.ops.low },
    });
    const ids = await sewingOpIds();
    expect(ids.has(ctx.ops.low)).toBe(true);
    expect(ids.has(ctx.ops.sleeve)).toBe(true);
    expect(ids.has(ctx.ops.full)).toBe(false);
  });

  test('закрыли низ-смену → снова COLLAPSED', async () => {
    await setOverride('AUTO');
    await closeLowShifts();
    const ids = await sewingOpIds();
    expect(ids.has(ctx.ops.full)).toBe(true);
    expect(ids.has(ctx.ops.low)).toBe(false);
  });

  test('FORCE_SPLIT держит две колонки даже без активной низ-смены', async () => {
    await closeLowShifts();
    await setOverride('FORCE_SPLIT');
    const ids = await sewingOpIds();
    expect(ids.has(ctx.ops.low)).toBe(true);
    expect(ids.has(ctx.ops.sleeve)).toBe(true);
    expect(ids.has(ctx.ops.full)).toBe(false);
  });

  test('снапшот маршрута ни разу не изменился (остался сплитом)', async () => {
    const steps = await ctx.prisma.orderRouteStep.findMany({
      where: { orderId: ctx.orderId },
      orderBy: { index: 'asc' },
    });
    const opIds = steps.map((s) => s.operationId);
    expect(opIds).toContain(ctx.ops.low);
    expect(opIds).toContain(ctx.ops.sleeve);
    expect(opIds).not.toContain(ctx.ops.full);
  });
});
