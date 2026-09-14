/**
 * Документ план→факт заказа (`GET /api/admin/production-cost/order/:id/document`,
 * `OrderProductionDocumentService`): ПЛАН строки материала берётся из активной сметы.
 *
 * Аудит движка расчёта 13.09.2026, D1-9: план строк нанесения/прочего брался НЕ из сметы, даже
 * когда смета есть, — `planRubByNeed` собирался только по kind MATERIAL/HARDWARE, и строка
 * нанесения уходила в фолбэк «к закупке × котировка»: в RUB это давало верные деньги с чужим
 * источником (`WORKSHOP_NEED` вместо `COST_ESTIMATE`), в USD — вовсе пропадала с
 * `PLAN_USD_SKIPPED`, хотя смета уже хранит `lineTotalRub` по курсу. Три витрины (смета,
 * документ, отчёт) давали три ответа на «план по нанесению».
 *
 * Сценарий: заказ 10 шт, ткань 0,5 кг/шт (5 кг × 300 ₽ = 1 500 ₽), нанесение «Вышивка, на
 * готовом изделии» 10 шт × 0,5 USD при курсе 90 → строка сметы 450,00 ₽ (или 10 × 45 ₽ в RUB).
 *   смета:    MATERIAL 1 500,00 + APPLICATION 450,00 = 1 950,00 ₽;
 *   документ: ОБЕ строки planSource COST_ESTIMATE, totals.planMaterialsRub 1 950,00, без
 *             PLAN_USD_SKIPPED.
 * Плюс фолбэк: USD-строка, которой в смете нет, считается по курсу сметы, а не выбрасывается.
 */
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';

const QTY = 10;
const FABRIC_QTY = 5; // 10 шт × 0,5 кг
const FABRIC_PRICE_RUB = 300;
const FABRIC_PLAN_RUB = FABRIC_QTY * FABRIC_PRICE_RUB; // 1 500
const APP_QTY = 10;
const APP_PRICE_USD = 0.5;
const USD_RATE = 90;
const APP_PLAN_RUB = APP_QTY * APP_PRICE_USD * USD_RATE; // 5 USD × 90 = 450
const APP_PRICE_RUB = 45; // RUB-вариант: 10 × 45 = 450

type MaterialRow = {
  key: string;
  name: string;
  planQty: string | null;
  planRub: string | null;
  planSource: string;
  warnings: string[];
};
type EstimateLine = {
  workshopNeedId: string | null;
  kind: string;
  quotedCurrency: string | null;
  lineTotalRub: string;
};
type DocBody = {
  materials: MaterialRow[];
  totals: {
    planMaterialsRub: string;
    planDirectRub: string;
    marginRub: string | null;
    marginNote: string | null;
  };
  warnings: string[];
};

describeWithDb('integration — документ план→факт: план строк из сметы (D1-9)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let manager: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    manager = loginAs(t, seed.employees['shop-chief']);
  });

  const api = () => request(t.app.getHttpServer());

  /**
   * Заказ 10 шт (M) с тканью по спецификации + одно нанесение; доведён до CALCULATION_DONE со
   * сметой. Цена нанесения — в переданной валюте.
   */
  async function prepare(appCurrency: 'USD' | 'RUB'): Promise<{
    orderId: string;
    fabricNeedId: string;
    appNeedId: string;
    estimateLines: EstimateLine[];
    usdRateRub: string | null;
  }> {
    const spec = await createSpecPattern(t, manager, {
      name: 'Спецификация D1-9',
      materialLines: [
        { name: 'Кулирка D1-9', unit: 'кг', qtyPerUnit: '0.5', materialRole: 'MAIN_FABRIC' },
      ],
    });
    const created = await api()
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-09-10T00:00:00.000Z',
        clientId: seed.client.id,
        productId: seed.product.id,
        patternItemId: spec.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: QTY }],
      })
      .expect(201);
    const orderId = created.body.id as string;

    await api()
      .put(`/api/orders/${orderId}/applications`)
      .set('Cookie', manager)
      .send({
        applications: [
          { type: 'EMBROIDERY', stage: 'FINISHED_ITEM', quantity: String(APP_QTY), unit: 'шт' },
        ],
      })
      .expect(200);

    await api().post(`/api/orders/${orderId}/start-calculation`).set('Cookie', manager).send({}).expect(201);

    const needs = await t.prisma.workshopNeed.findMany({
      where: { orderId, NOT: { status: 'CANCELLED' } },
      select: { id: true, sourceType: true },
    });
    const appNeed = needs.find((n) => n.sourceType === 'ORDER_APPLICATION');
    const fabricNeed = needs.find((n) => n.sourceType !== 'ORDER_APPLICATION');
    expect(appNeed, 'строка потребности по нанесению').toBeDefined();
    expect(fabricNeed, 'строка потребности по ткани').toBeDefined();
    expect(needs).toHaveLength(2);

    await api()
      .patch(`/api/workshop-needs/${fabricNeed!.id}`)
      .set('Cookie', manager)
      .send({ purchaseQty: String(FABRIC_QTY), quotedPrice: String(FABRIC_PRICE_RUB), quotedCurrency: 'RUB' })
      .expect(200);
    await api()
      .patch(`/api/workshop-needs/${appNeed!.id}`)
      .set('Cookie', manager)
      .send({
        purchaseQty: String(APP_QTY),
        quotedPrice: String(appCurrency === 'USD' ? APP_PRICE_USD : APP_PRICE_RUB),
        quotedCurrency: appCurrency,
      })
      .expect(200);

    const est = await api()
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', manager)
      .send(appCurrency === 'USD' ? { usdRateRub: String(USD_RATE) } : {})
      .expect(201);
    return {
      orderId,
      fabricNeedId: fabricNeed!.id,
      appNeedId: appNeed!.id,
      estimateLines: est.body.lines as EstimateLine[],
      usdRateRub: est.body.usdRateRub ?? null,
    };
  }

  async function getDocument(orderId: string): Promise<DocBody> {
    const res = await api()
      .get(`/api/admin/production-cost/order/${orderId}/document`)
      .set('Cookie', manager)
      .expect(200);
    return res.body as DocBody;
  }

  test('USD-нанесение: план строки = строка сметы по курсу, источник COST_ESTIMATE, итог со сметой сходится', async () => {
    const { orderId, fabricNeedId, appNeedId, estimateLines } = await prepare('USD');

    // Контроль: смета хранит строку APPLICATION по этой потребности с рублёвым итогом 450,00.
    const appLine = estimateLines.find((l) => l.workshopNeedId === appNeedId);
    expect(appLine?.kind).toBe('APPLICATION');
    expect(appLine?.quotedCurrency).toBe('USD');
    expect(Number(appLine?.lineTotalRub)).toBe(APP_PLAN_RUB);

    const doc = await getDocument(orderId);
    const fabricRow = doc.materials.find((m) => m.key === fabricNeedId);
    const appRow = doc.materials.find((m) => m.key === appNeedId);
    expect(fabricRow).toBeDefined();
    expect(appRow).toBeDefined();

    // Ткань — из сметы (как и раньше).
    expect(fabricRow!.planRub).toBe(FABRIC_PLAN_RUB.toFixed(2));
    expect(fabricRow!.planSource).toBe('COST_ESTIMATE');
    // Нанесение — ТОЖЕ из сметы: раньше planRub null + PLAN_USD_SKIPPED.
    expect(appRow!.planRub).toBe(APP_PLAN_RUB.toFixed(2)); // '450.00'
    expect(appRow!.planSource).toBe('COST_ESTIMATE');
    expect(doc.warnings).not.toContain('PLAN_USD_SKIPPED');
    // Итог плана материалов документа = Σ строк сметы по потребностям.
    expect(doc.totals.planMaterialsRub).toBe((FABRIC_PLAN_RUB + APP_PLAN_RUB).toFixed(2)); // '1950.00'
    const estimateMaterialsRub = estimateLines
      .filter((l) => l.workshopNeedId != null)
      .reduce((s, l) => s + Number(l.lineTotalRub), 0);
    expect(Number(doc.totals.planMaterialsRub)).toBe(estimateMaterialsRub);
  });

  test('RUB-нанесение: источник плана — смета, а не потребность (витрины не расходятся)', async () => {
    const { orderId, fabricNeedId, appNeedId, estimateLines } = await prepare('RUB');
    const appLine = estimateLines.find((l) => l.workshopNeedId === appNeedId);
    expect(appLine?.kind).toBe('APPLICATION');
    expect(Number(appLine?.lineTotalRub)).toBe(APP_QTY * APP_PRICE_RUB);

    const doc = await getDocument(orderId);
    const fabricRow = doc.materials.find((m) => m.key === fabricNeedId)!;
    const appRow = doc.materials.find((m) => m.key === appNeedId)!;
    expect(appRow.planRub).toBe((APP_QTY * APP_PRICE_RUB).toFixed(2)); // '450.00'
    expect(doc.totals.planMaterialsRub).toBe((FABRIC_PLAN_RUB + APP_QTY * APP_PRICE_RUB).toFixed(2));
    expect(doc.warnings).not.toContain('PLAN_USD_SKIPPED');
    // Раньше: ткань COST_ESTIMATE, нанесение той же сметы — WORKSHOP_NEED.
    expect(fabricRow.planSource).toBe('COST_ESTIMATE');
    expect(appRow.planSource).toBe('COST_ESTIMATE');
  });

  test('фолбэк: USD-строка, которой нет в смете, считается по курсу сметы, а не выбрасывается', async () => {
    const { orderId, usdRateRub } = await prepare('USD');
    expect(Number(usdRateRub)).toBe(USD_RATE);

    // Строка появилась ПОСЛЕ сметы и в неё не попала (прямая запись, без пересчёта сметы):
    // у документа есть только живая потребность и курс сметы.
    const late = await t.prisma.workshopNeed.create({
      data: {
        orderId,
        sourceType: 'MANUAL_ADDITION',
        isManual: true,
        materialRole: 'PACKAGING',
        description: 'Пакеты (после сметы)',
        unit: 'шт',
        calculationMethod: 'QTY_PER_UNIT',
        status: 'REVIEWED',
        calculatedQty: new Prisma.Decimal(APP_QTY),
        purchaseQty: new Prisma.Decimal(APP_QTY),
        quotedPrice: new Prisma.Decimal(APP_PRICE_USD),
        quotedCurrency: 'USD',
      },
      select: { id: true },
    });

    const doc = await getDocument(orderId);
    const lateRow = doc.materials.find((m) => m.key === late.id);
    expect(lateRow).toBeDefined();
    // 10 × 0,5 USD = 5 USD × 90 = 450 ₽ — той же формулой, что смета. Раньше: null + PLAN_USD_SKIPPED.
    expect(lateRow!.planRub).toBe(APP_PLAN_RUB.toFixed(2));
    expect(lateRow!.planSource).toBe('WORKSHOP_NEED');
    expect(doc.warnings).not.toContain('PLAN_USD_SKIPPED');
    expect(doc.totals.planMaterialsRub).toBe((FABRIC_PLAN_RUB + APP_PLAN_RUB + APP_PLAN_RUB).toFixed(2));
  });

  test('E1-6 (ревью): маржа документа подписана «по прямым затратам» — без логистики/прочих/лекала', async () => {
    const { orderId } = await prepare('RUB');
    // Без цены клиента маржи нет — и подписи тоже.
    let doc = await getDocument(orderId);
    expect(doc.totals.marginRub).toBeNull();
    expect(doc.totals.marginNote).toBeNull();

    // Выручка в рублях + логистика 45 000: в `factDirect` она не входит, и маржа завышена ровно
    // на неё — подпись обязана это сказать, а имена прежних полей остаются (их читает фронт ERP).
    await t.prisma.order.update({
      where: { id: orderId },
      data: { customerUnitPrice: new Prisma.Decimal(1000), customerCurrency: 'RUB' },
    });
    await t.prisma.orderLogisticsLine.create({
      data: { orderId, sortOrder: 0, name: 'Доставка ткани', costRub: new Prisma.Decimal(45000) },
    });
    doc = await getDocument(orderId);
    expect(doc.totals.marginRub).not.toBeNull();
    expect(doc.totals.marginNote).toBe(
      'по прямым затратам — без логистики, прочих расходов и разработки лекала',
    );
  });
});
