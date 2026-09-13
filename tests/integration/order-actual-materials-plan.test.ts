/**
 * Отчёт «Материалы: план → факт по заказу» (`GET /api/costs/actual-materials`,
 * `OrderActualMaterialsService`): план и факт считаются ТЕМИ ЖЕ правилами, что смета и документ
 * план→факт (`GET /api/admin/production-cost/order/:id/document`) — он здесь эталон.
 *
 * Аудит движка расчёта 13.09.2026, D1-11 — три расхождения витрин:
 *   1. fallback-план без сметы фильтровал строки по трём `sourceType`, а не по классификации
 *      `getWorkshopNeedKind` — основная ткань по параметрам лекала (`PATTERN_SIZE_PARAMETER_VALUE`)
 *      и ручные строки закупщика (`MANUAL_ADDITION` с ролью) выпадали из плана;
 *   2. цена бралась только из `quotedPrice` — строка под ERP (`erpUnitPriceRub`, котировки нет)
 *      проходила фильтр и давала план 0 без предупреждения;
 *   3. политика заказа `materialsAndHardwareCostPolicy = EXCLUDE` (давальческое) не читалась
 *      вовсе: план из сметы 100 000 и факт приёмки 2 000 → «экономия 98 000» и искажённая база
 *      распределения накладных, тогда как документ и смета дают 0 / 0.
 *
 * Отчёт строится только по заказам с POSTED-приёмками (ранний return без них) — образец
 * `order-actual-materials-overhead.test.ts::orderWithReceipt`.
 */
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

// Кейс 1: четыре строки потребности без сметы.
const A_QTY = 10, A_PRICE = 1000, A_RUB = A_QTY * A_PRICE; // 10 000 — строка заказа, считалась и раньше
const B_QTY = 20, B_PRICE = 500, B_RUB = B_QTY * B_PRICE; // 10 000 — ткань по размерам лекала
const C_QTY = 5, C_PRICE = 100, C_RUB = C_QTY * C_PRICE; // 500 — ручная строка закупщика (фурнитура)
const D_QTY = 10, D_ERP_PRICE = 300, D_RUB = D_QTY * D_ERP_PRICE; // 3 000 — под ERP, цена её заказа
const CASE1_PLAN = A_RUB + B_RUB + C_RUB + D_RUB; // 23 500
const RECEIPT_QTY = 10, RECEIPT_PRICE = 1000, RECEIPT_RUB = RECEIPT_QTY * RECEIPT_PRICE; // 10 000

// Кейс 2: давальческое (EXCLUDE) со сметой.
const EXCL_ESTIMATE_MATERIAL_RUB = 100_000;
const EXCL_RECEIPT_QTY = 10, EXCL_RECEIPT_PRICE = 200;

type ReportRow = {
  orderId: string;
  planMaterialsRub: string;
  planSource: string;
  factMaterialsRub: string;
  varianceRub: string;
  receiptLinesCount: number;
  planDirectRub: string;
  factDirectRub: string;
  warnings: string[];
};
type ReportBody = { rows: ReportRow[] };
type DocBody = {
  totals: { planMaterialsRub: string; receivedMaterialsRub: string };
};

describeWithDb('integration — отчёт actual-materials считает план/факт как смета и документ (D1-11)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookie: string;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookie = loginAs(t, seed.employees['shop-chief']);
  });

  const api = () => request(t.app.getHttpServer());
  const uid = () => `${Date.now().toString(36)}-${++n}`;

  /** Заказ IN_PRODUCTION с одной POSTED-приёмкой (чтобы попасть в отчёт). */
  async function orderWithReceipt(opts: {
    policy?: 'INCLUDE' | 'EXCLUDE';
    receiptQty: number;
    receiptPrice: number;
  }): Promise<string> {
    const order = await t.prisma.order.create({
      data: {
        number: `O-D111-${uid()}`,
        orderDate: new Date('2026-09-01T00:00:00.000Z'),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        materialsAndHardwareCostPolicy: opts.policy ?? 'INCLUDE',
        items: { create: { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 10 } },
      },
      select: { id: true },
    });
    const supplier = await t.prisma.supplier.create({
      data: { name: `Поставщик ${uid()}` },
      select: { id: true, name: true },
    });
    const po = await t.prisma.purchaseOrder.create({
      data: {
        number: `PO-D111-${uid()}`,
        supplierId: supplier.id,
        supplierNameSnapshot: supplier.name,
        status: 'POSTED',
      },
      select: { id: true },
    });
    await t.prisma.purchaseReceipt.create({
      data: {
        number: `PR-D111-${uid()}`,
        status: 'POSTED',
        purchaseOrderId: po.id,
        customerOrderId: order.id,
        receivedAt: new Date('2026-09-05T00:00:00.000Z'),
        lines: {
          create: {
            status: 'POSTED',
            itemNameSnapshot: 'Кулирка',
            unitSnapshot: 'кг',
            unit: 'кг',
            receivedQty: new Prisma.Decimal(opts.receiptQty),
            priceSnapshot: new Prisma.Decimal(opts.receiptPrice),
            currencySnapshot: 'RUB',
          },
        },
      },
    });
    return order.id;
  }

  type NeedSpec = {
    sourceType: string;
    materialRole: string;
    calculatedQty: number;
    quotedPrice: number | null;
    description: string;
    unit?: string;
    calculationMethod?: string;
    isManual?: boolean;
    erpUnitPriceRub?: number;
  };

  async function seedNeed(orderId: string, s: NeedSpec): Promise<string> {
    const row = await t.prisma.workshopNeed.create({
      data: {
        orderId,
        sourceType: s.sourceType,
        isManual: s.isManual ?? false,
        materialRole: s.materialRole,
        description: s.description,
        unit: s.unit ?? 'кг',
        calculationMethod: s.calculationMethod ?? 'QTY_PER_UNIT',
        status: 'REVIEWED',
        calculatedQty: new Prisma.Decimal(s.calculatedQty),
        quotedPrice: s.quotedPrice == null ? null : new Prisma.Decimal(s.quotedPrice),
        quotedCurrency: s.quotedPrice == null ? null : 'RUB',
        ...(s.erpUnitPriceRub != null
          ? {
              erpManagedAt: new Date('2026-09-02T00:00:00.000Z'),
              erpPurchaseOrderRef: `ERP-ЗП-${uid()}`,
              erpUnitPriceRub: new Prisma.Decimal(s.erpUnitPriceRub),
            }
          : {}),
      },
      select: { id: true },
    });
    return row.id;
  }

  const NEED_A: NeedSpec = {
    sourceType: 'ORDER_MATERIAL_REQUIREMENT', materialRole: 'MAIN_FABRIC',
    calculatedQty: A_QTY, quotedPrice: A_PRICE, description: 'A Кулирка (строка заказа)',
  };
  const NEED_B: NeedSpec = {
    sourceType: 'PATTERN_SIZE_PARAMETER_VALUE', materialRole: 'MAIN_FABRIC', calculationMethod: 'LINEAR_M_BY_SIZE',
    calculatedQty: B_QTY, quotedPrice: B_PRICE, description: 'B Основная ткань (пог. м по размерам)', unit: 'м',
  };
  const NEED_C: NeedSpec = {
    sourceType: 'MANUAL_ADDITION', isManual: true, materialRole: 'PACKAGING',
    calculatedQty: C_QTY, quotedPrice: C_PRICE, description: 'C Пакеты (ручная строка закупщика)', unit: 'шт',
  };
  const NEED_D: NeedSpec = {
    sourceType: 'ORDER_MATERIAL_REQUIREMENT', materialRole: 'MAIN_FABRIC',
    calculatedQty: D_QTY, quotedPrice: null, erpUnitPriceRub: D_ERP_PRICE, description: 'D Кулирка под ERP',
  };

  async function report(): Promise<ReportBody> {
    const res = await api().get('/api/costs/actual-materials').set('Cookie', cookie).expect(200);
    return res.body as ReportBody;
  }
  async function document(orderId: string): Promise<DocBody> {
    const res = await api()
      .get(`/api/admin/production-cost/order/${orderId}/document`)
      .set('Cookie', cookie)
      .expect(200);
    return res.body as DocBody;
  }
  function rowOf(body: ReportBody, orderId: string): ReportRow {
    const row = body.rows.find((r) => r.orderId === orderId);
    expect(row, `строка отчёта для заказа ${orderId}`).toBeDefined();
    return row!;
  }

  test('без сметы план собирается по классификации строк и цене ERP — как документ план→факт', async () => {
    const orderId = await orderWithReceipt({ receiptQty: RECEIPT_QTY, receiptPrice: RECEIPT_PRICE });
    for (const need of [NEED_A, NEED_B, NEED_C, NEED_D]) await seedNeed(orderId, need);

    // Эталон: документ план→факт на тех же данных — 23 500 = 10 000 + 10 000 + 500 + 3 000.
    const doc = await document(orderId);
    expect(doc.totals.planMaterialsRub).toBe(CASE1_PLAN.toFixed(2));

    const row = rowOf(await report(), orderId);
    // Раньше: '10000.00' — только строка A; B/C/D терялись без единого предупреждения.
    expect(row.planMaterialsRub).toBe(CASE1_PLAN.toFixed(2)); // '23500.00'
    expect(row.planSource).toBe('WORKSHOP_NEED');
    expect(row.warnings).toEqual([]);
    expect(row.factMaterialsRub).toBe(RECEIPT_RUB.toFixed(2));
    expect(row.receiptLinesCount).toBe(1);
  });

  test('каждая из потерянных строк считается и в одиночку: ткань по размерам, ручная фурнитура, строка под ERP', async () => {
    const ob = await orderWithReceipt({ receiptQty: 1, receiptPrice: 1 });
    await seedNeed(ob, NEED_B);
    const oc = await orderWithReceipt({ receiptQty: 1, receiptPrice: 1 });
    await seedNeed(oc, NEED_C);
    const od = await orderWithReceipt({ receiptQty: 1, receiptPrice: 1 });
    await seedNeed(od, NEED_D);

    const body = await report();
    const rb = rowOf(body, ob);
    const rc = rowOf(body, oc);
    const rd = rowOf(body, od);
    // Раньше B/C → «плана нет» (NONE, 0), D → WORKSHOP_NEED с планом 0 и без warning.
    expect(rb.planMaterialsRub).toBe(B_RUB.toFixed(2));
    expect(rb.planSource).toBe('WORKSHOP_NEED');
    expect(rc.planMaterialsRub).toBe(C_RUB.toFixed(2));
    expect(rc.planSource).toBe('WORKSHOP_NEED');
    expect(rd.planMaterialsRub).toBe(D_RUB.toFixed(2));
    expect(rd.planSource).toBe('WORKSHOP_NEED');
    expect(rd.warnings).toEqual([]);
    // Сверка с документом план→факт по каждому заказу.
    expect((await document(ob)).totals.planMaterialsRub).toBe(B_RUB.toFixed(2));
    expect((await document(oc)).totals.planMaterialsRub).toBe(C_RUB.toFixed(2));
    expect((await document(od)).totals.planMaterialsRub).toBe(D_RUB.toFixed(2));
  });

  test('давальческое (EXCLUDE): деньги материала — ноль и в плане из сметы, и в факте приёмки', async () => {
    const orderId = await orderWithReceipt({
      policy: 'EXCLUDE',
      receiptQty: EXCL_RECEIPT_QTY,
      receiptPrice: EXCL_RECEIPT_PRICE,
    });
    const needId = await seedNeed(orderId, {
      sourceType: 'ORDER_MATERIAL_REQUIREMENT', materialRole: 'MAIN_FABRIC',
      calculatedQty: 100, quotedPrice: 1000, description: 'Ткань заказчика (давальческая)',
    });
    // Смета COMPLETED: строка MATERIAL 100 000 ₽ хранится полной стоимостью
    // (`OrderCostEstimatesService`), из итога при EXCLUDE исключена → totalCostRub 0.
    await t.prisma.orderCostEstimate.create({
      data: {
        orderId,
        version: 1,
        status: 'COMPLETED',
        totalCostRub: new Prisma.Decimal(0),
        lines: {
          create: [{
            workshopNeedId: needId,
            sourceType: 'ORDER_MATERIAL_REQUIREMENT',
            kind: 'MATERIAL',
            description: 'Ткань заказчика (давальческая)',
            unit: 'кг',
            calculatedQty: new Prisma.Decimal(100),
            purchaseQty: new Prisma.Decimal(100),
            quotedPrice: new Prisma.Decimal(1000),
            quotedCurrency: 'RUB',
            lineTotalOriginal: new Prisma.Decimal(EXCL_ESTIMATE_MATERIAL_RUB),
            lineTotalRub: new Prisma.Decimal(EXCL_ESTIMATE_MATERIAL_RUB),
          }],
        },
      },
    });

    // Эталон: документ план→факт зануляет деньги MATERIAL/HARDWARE при EXCLUDE.
    const doc = await document(orderId);
    expect(doc.totals.planMaterialsRub).toBe('0.00');
    expect(doc.totals.receivedMaterialsRub).toBe('0.00');

    const row = rowOf(await report(), orderId);
    // Раньше: план 100 000 / факт 2 000 / отклонение −98 000, и та же сумма — в базе накладных.
    expect(row.planSource).toBe('COST_ESTIMATE');
    expect(row.planMaterialsRub).toBe('0.00');
    expect(row.factMaterialsRub).toBe('0.00');
    expect(row.varianceRub).toBe('0.00');
    expect(row.planDirectRub).toBe('0.00');
    expect(row.factDirectRub).toBe('0.00');
  });

  test('давальческое (EXCLUDE): приёмка по потребности нанесения остаётся — её платит цех', async () => {
    const orderId = await orderWithReceipt({ policy: 'EXCLUDE', receiptQty: 1, receiptPrice: 1 });
    const appNeedId = await seedNeed(orderId, {
      sourceType: 'ORDER_APPLICATION', materialRole: 'APPLICATION',
      calculatedQty: 10, quotedPrice: 30, description: 'Вышивка', unit: 'шт',
    });
    // Приёмка услуги нанесения 10 × 30 = 300 ₽ по этой потребности.
    await t.prisma.purchaseReceiptLine.updateMany({
      where: { purchaseReceipt: { customerOrderId: orderId } },
      data: {
        workshopNeedId: appNeedId,
        receivedQty: new Prisma.Decimal(10),
        priceSnapshot: new Prisma.Decimal(30),
      },
    });

    const row = rowOf(await report(), orderId);
    // Нанесение — не давальческий материал: факт 300 остаётся, план по нему отчёт не считает
    // (план отчёта — только MATERIAL/HARDWARE, по замыслу).
    expect(row.factMaterialsRub).toBe('300.00');
    expect(row.planMaterialsRub).toBe('0.00');
  });
});
