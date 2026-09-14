/**
 * ДВИЖОК МАТЕРИАЛА ФАКТА (`OrderMaterialCostService`) — условия и множества, а не арифметика.
 *
 * Аудит движка расчёта 13.09.2026, группа A1_costs_material. Каждый блок — одна находка, и цена
 * ошибки здесь не падение, а НЕПРАВИЛЬНОЕ ЧИСЛО в `materials_own_rub` документа выпуска, которое
 * уезжает в ERP (`cost_materials_own`) и никем не проверяется:
 *
 *   D1-1  — отменённая закупщиком строка потребности считалась нормой (55 000 вместо 30 000);
 *   D1-6 ≡ E1-8 — цена ЗП/приёмки «последняя строка побеждает» (Σqty × случайная цена), отменённые
 *           приёмки и отменённые строки живого ЗП складывались с проведёнными;
 *   E1-7  — цена в USD давала 0 ₽ с кодом «цены нет», хотя курс зафиксирован в смете.
 *
 * Фикстура — как в `material-policy.test.ts`: закрытый заказ на 10 шт, одна потребность, факты
 * заводятся prisma-ом, документ пересобирается кнопкой.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, refreshAdminCookie, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';
import type { ErpProductionService } from '../../apps/api/src/modules/integrations/erp-production.service.js';
import { buildErpProductionService } from '../utils/erp-services';

describeWithDb('integration — движок материала факта: отменённые строки, взвешенная цена, USD', () => {
  let t: TestApp;
  let seed: SeedResult;
  let c: Record<string, string>;

  const http = () => request(t.app.getHttpServer());

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
    c = { admin: t.adminCookie, manager: loginAs(t, seed.employees['shop-chief']) };
  });

  /** resetDatabase не трункейтит CompanySettings — оси выставляем явно. */
  async function setSources(qty: string, price: string): Promise<void> {
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        singleton: true,
        materialQtySource: qty as never,
        materialPriceSource: price as never,
        autoIssueMaterialsOnCutRelease: false,
        erpFinishedGoodsSince: new Date('2026-08-01T00:00:00.000Z'),
      },
      update: {
        materialQtySource: qty as never,
        materialPriceSource: price as never,
        autoIssueMaterialsOnCutRelease: false,
        erpFinishedGoodsSince: new Date('2026-08-01T00:00:00.000Z'),
      },
    });
  }

  /** Заказ на 10 шт по спецификации, запущен, паспорт на весь тираж упакован, заказ закрыт. */
  async function closedOrder(opts: { fromErp?: boolean } = {}): Promise<string> {
    const spec = await createSpecPattern(t, c.manager, {
      materialLines: [
        { name: 'Кулирка чёрная', unit: 'кг', qtyPerUnit: '0.5', materialRole: 'MAIN_FABRIC', colorRule: 'ORDER_COLOR' },
      ],
    });
    const order = await http()
      .post('/api/orders')
      .set('Cookie', c.manager)
      .send({
        orderDate: '2026-09-01T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        patternItemId: spec.id,
        ...(opts.fromErp ? { erpCustomerOrderId: 'erp-order-mce', erpCustomerOrderNumber: 'ФС-00MCE' } : {}),
      });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId: string = order.body.id;
    const started = await http().post(`/api/orders/${orderId}/start`).set('Cookie', c.manager).send({});
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const passport = await http()
      .post('/api/passports')
      .set('Cookie', c.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: `R-MCE-${Math.random().toString(36).slice(2, 6)}`,
        cutDate: '2026-09-01T00:00:00.000Z',
        qtyCut: 10,
        cutterId: seed.employees.cutter.id,
      });
    expect(passport.status, JSON.stringify(passport.body)).toBe(201);
    // PACKED через prisma — обход 409 PACKING_SHIFT_REQUIRED, как в зелёных тестах документа.
    await t.prisma.passport.update({ where: { id: passport.body.id }, data: { status: 'PACKED', qtyGood: 10 } });
    const done = await http().post(`/api/orders/${orderId}/complete`).set('Cookie', c.manager).send({});
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    return orderId;
  }

  async function need(orderId: string, description: string, calculatedQty: string, quotedPrice: string, quotedCurrency = 'RUB') {
    return t.prisma.workshopNeed.create({
      data: {
        orderId, description, unit: 'кг', calculatedQty, quotedPrice, quotedCurrency,
        materialRole: 'MAIN_FABRIC', status: 'PURCHASE_PLANNED',
      },
    });
  }

  async function purchaseOrder() {
    const supplier = await t.prisma.supplier.create({ data: { name: `Ткани Опт ${Math.random().toString(36).slice(2, 6)}` } });
    return t.prisma.purchaseOrder.create({
      data: { number: `PO-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, supplierId: supplier.id, supplierNameSnapshot: supplier.name, status: 'CONFIRMED' },
    });
  }

  async function poLine(
    poId: string,
    needId: string,
    qty: string,
    price: string,
    opts: { currency?: string; status?: string; confirmed?: boolean } = {},
  ) {
    const confirmed = opts.confirmed ?? true;
    return t.prisma.purchaseOrderLine.create({
      data: {
        purchaseOrderId: poId, workshopNeedId: needId, itemNameSnapshot: 'Кулирка', unitSnapshot: 'кг',
        qty, price, currency: opts.currency ?? 'RUB',
        ...(confirmed ? { confirmedQty: qty, confirmedPrice: price } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
    });
  }

  async function receipt(
    poId: string,
    poLineId: string,
    needId: string,
    qty: string,
    price: string,
    opts: { status?: 'POSTED' | 'CANCELLED'; currency?: string } = {},
  ) {
    const status = opts.status ?? 'POSTED';
    const r = await t.prisma.purchaseReceipt.create({
      data: { number: `RC-${Math.random().toString(36).slice(2, 8)}`, purchaseOrderId: poId, status },
    });
    await t.prisma.purchaseReceiptLine.create({
      data: {
        purchaseReceiptId: r.id, purchaseOrderLineId: poLineId, workshopNeedId: needId,
        itemNameSnapshot: 'Кулирка', unitSnapshot: 'кг', receivedQty: qty, unit: 'кг',
        priceSnapshot: price, currencySnapshot: opts.currency ?? 'RUB', status,
      },
    });
  }

  /** Кнопка «пересобрать по фактам» — настройка сама пересборку не зовёт. */
  async function rebuild(orderId: string) {
    const res = await http().post(`/api/admin/orders/${orderId}/production-document`).set('Cookie', c.manager).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  }

  async function planFact(orderId: string) {
    const res = await http().get(`/api/admin/production-cost/order/${orderId}/document`).set('Cookie', c.manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  /** Очередь сдачи в ERP на тестовом prisma (DI-версия требует TenantContext HTTP-запроса). */
  function erpQueue(): ErpProductionService {
    // Слияние правок аудита 13.09: очередь сдачи зависит от ProductionDocumentsService (D1-3) — общий хелпер.
    return buildErpProductionService(t);
  }

  // ---------------------------------------------------------------------------
  // D1-1 — отменённая потребность
  // ---------------------------------------------------------------------------

  test('D1-1: отменённая строка потребности не входит в materials_own_rub — ни нормой, ни в очередь ERP', async () => {
    const orderId = await closedOrder({ fromErp: true });
    const a = await need(orderId, 'A Кулирка 180', '50', '500');
    const b = await need(orderId, 'B Футер 240', '60', '500');
    // Отмена — настоящей ручкой закупщика (она же исключает строку из сметы).
    const cancel = await http().post(`/api/workshop-needs/${a.id}/cancel`).set('Cookie', c.admin).send({});
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(201);

    await setSources('ISSUED_OR_CALCULATED', 'PLANNED');
    const doc = await rebuild(orderId);
    const ids = doc.materialLines.map((l: any) => l.workshopNeedId);
    expect(ids).not.toContain(a.id);
    expect(ids).toContain(b.id);
    // Ровно столько же показывают смета и документ план→факт на тех же данных.
    expect(doc.cost.materialsOwnRub).toBe(30000);
    expect(doc.cost.warnings).not.toContain('NO_MATERIAL_FACT');
    expect((await planFact(orderId)).totals.planMaterialsRub).toBe('30000.00');

    const queue = await erpQueue().listPending(10);
    expect(queue.count).toBe(1);
    expect((queue.items[0] as any).cost.materials_own_rub).toBe(30000);
  });

  test('D1-1: ЗП и приёмки по отменённой строке в затраты не берутся (ORDERED / RECEIVED / ALL_PURCHASED)', async () => {
    const orderId = await closedOrder();
    const a = await need(orderId, 'A Кулирка 180', '50', '500');
    await need(orderId, 'B Футер 240', '60', '500');
    const po = await purchaseOrder();
    const line = await poLine(po.id, a.id, '50', '500');
    await receipt(po.id, line.id, a.id, '50', '500');
    const cancel = await http().post(`/api/workshop-needs/${a.id}/cancel`).set('Cookie', c.admin).send({});
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(201);

    await setSources('ORDERED', 'PURCHASE');
    let doc = await rebuild(orderId);
    // Единственный ЗП — по отменённой строке: считать нечего, и об этом сказано вслух.
    expect(doc.materialLines.map((l: any) => l.workshopNeedId)).not.toContain(a.id);
    expect(doc.cost.materialsOwnRub).toBe(0);
    expect(doc.cost.warnings).toContain('NO_MATERIAL_FACT');

    await setSources('RECEIVED', 'RECEIPT');
    doc = await rebuild(orderId);
    expect(doc.cost.materialsOwnRub).toBe(0);

    await t.prisma.order.update({ where: { id: orderId }, data: { materialRecognition: 'ALL_PURCHASED' } });
    await setSources('ISSUED_OR_CALCULATED', 'PURCHASE');
    doc = await rebuild(orderId);
    // «Вся закупка под заказ» — но живая строка B закупок не имеет, а закупка A снята вместе со строкой.
    expect(doc.materialLines).toHaveLength(1);
    expect(doc.materialLines[0].qtyStep).toBe('CALCULATED');
    expect(doc.cost.materialsOwnRub).toBe(30000);
  });

  test('D1-1: реальный расход по строке, отменённой уже после выдачи, не теряется', async () => {
    const orderId = await closedOrder();
    const a = await need(orderId, 'A Кулирка 180', '50', '500');
    const b = await need(orderId, 'B Футер 240', '60', '500');
    // Выдали 5 кг по A, потом закупщик её отменил — материал-то ушёл в производство.
    await t.prisma.materialIssue.create({
      data: {
        orderId, status: 'POSTED', totalCost: '2500', postedAt: new Date(),
        lines: { create: [{ workshopNeedId: a.id, description: 'A Кулирка 180', unit: 'кг', issuedQty: '5', unitCost: '500', totalCost: '2500' }] },
      },
    });
    const cancel = await http().post(`/api/workshop-needs/${a.id}/cancel`).set('Cookie', c.admin).send({});
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(201);

    await setSources('ISSUED_OR_CALCULATED', 'PLANNED');
    const doc = await rebuild(orderId);
    const lineA = doc.materialLines.find((l: any) => l.workshopNeedId === a.id);
    const lineB = doc.materialLines.find((l: any) => l.workshopNeedId === b.id);
    // A — только списанное (5 кг × 500), без нормы; B — норма 60 кг × 500.
    expect(lineA?.qtyStep).toBe('ISSUED');
    expect(lineA?.qty).toBe(5);
    expect(lineA?.totalRub).toBe(2500);
    expect(lineB?.qtyStep).toBe('CALCULATED');
    expect(doc.cost.materialsOwnRub).toBe(32500);

    // А там, где расход не учитывается вовсе, отменённой строки нет.
    await setSources('CALCULATED', 'PLANNED');
    const norm = await rebuild(orderId);
    expect(norm.materialLines.map((l: any) => l.workshopNeedId)).toEqual([b.id]);
    expect(norm.cost.materialsOwnRub).toBe(30000);
  });

  // ---------------------------------------------------------------------------
  // D1-6 ≡ E1-8 — взвешенная цена, статусы строк ЗП и приёмок
  // ---------------------------------------------------------------------------

  test('E1-8: две строки ЗП с разными ценами — средневзвешенная, а не «последняя побеждает»', async () => {
    const orderId = await closedOrder();
    const n = await need(orderId, 'Кулирка чёрная', '47', '400');
    const po = await purchaseOrder();
    await poLine(po.id, n.id, '60', '500');
    await poLine(po.id, n.id, '40', '600');

    await setSources('ORDERED', 'PURCHASE');
    let doc = await rebuild(orderId);
    expect(doc.materialLines).toHaveLength(1);
    expect(doc.materialLines[0].qty).toBe(100);
    // (60 × 500 + 40 × 600) / 100 = 540 ₽/кг → 54 000 ₽.
    expect(doc.materialLines[0].unitPriceRub).toBe(540);
    expect(doc.materialLines[0].priceStep).toBe('PURCHASE_CONFIRMED');
    expect(doc.cost.materialsOwnRub).toBe(54000);

    // По умолчанию (`PURCHASE`) та же цена красит и норму: 47 × 540 = 25 380.
    await setSources('ISSUED_OR_CALCULATED', 'PURCHASE');
    doc = await rebuild(orderId);
    expect(doc.materialLines[0].qtyStep).toBe('CALCULATED');
    expect(doc.cost.materialsOwnRub).toBe(25380);
  });

  test('E1-8: отменённая строка живого ЗП в закупку не входит', async () => {
    const orderId = await closedOrder();
    const n = await need(orderId, 'Кулирка чёрная', '47', '400');
    const po = await purchaseOrder();
    await poLine(po.id, n.id, '60', '500');
    await poLine(po.id, n.id, '40', '600', { status: 'CANCELLED' });

    await setSources('ORDERED', 'PURCHASE');
    const doc = await rebuild(orderId);
    expect(doc.materialLines[0].qty).toBe(60);
    expect(doc.materialLines[0].unitPriceRub).toBe(500);
    expect(doc.cost.materialsOwnRub).toBe(30000);
  });

  test('D1-6a: отменённая приёмка не «принято» — 58 кг × 440, а не 116', async () => {
    const orderId = await closedOrder();
    const n = await need(orderId, 'Кулирка чёрная', '47', '400');
    const po = await purchaseOrder();
    const line = await poLine(po.id, n.id, '58', '440');
    await receipt(po.id, line.id, n.id, '58', '440', { status: 'CANCELLED' });
    await receipt(po.id, line.id, n.id, '58', '440');

    await setSources('RECEIVED', 'RECEIPT');
    const doc = await rebuild(orderId);
    expect(doc.materialLines[0].qty).toBe(58);
    expect(doc.materialLines[0].priceStep).toBe('RECEIPT');
    expect(doc.cost.materialsOwnRub).toBe(25520);
    // Документ план→факт того же заказа — та же цифра: витрины сходятся.
    expect((await planFact(orderId)).totals.receivedMaterialsRub).toBe('25520.00');
  });

  test('D1-6b: две проведённые приёмки по разным ценам — Σ(qty × price), а не Σqty × одна из цен', async () => {
    const orderId = await closedOrder();
    const n = await need(orderId, 'Кулирка чёрная', '47', '400');
    const po = await purchaseOrder();
    const line = await poLine(po.id, n.id, '58', '440');
    await receipt(po.id, line.id, n.id, '30', '400');
    await receipt(po.id, line.id, n.id, '28', '480');

    await setSources('RECEIVED', 'RECEIPT');
    const doc = await rebuild(orderId);
    expect(doc.materialLines[0].qty).toBe(58);
    // 30 × 400 + 28 × 480 = 25 440 (у автора находки опечатка «26 240»).
    expect(doc.cost.materialsOwnRub).toBe(25440);
    expect((await planFact(orderId)).totals.receivedMaterialsRub).toBe('25440.00');

    // Та же взвешенная цена приёмки и на списанное количество: `RECEIPT` при `ISSUED`.
    await t.prisma.materialIssue.create({
      data: {
        orderId, status: 'POSTED', totalCost: '0', postedAt: new Date(),
        lines: { create: [{ workshopNeedId: n.id, description: 'Кулирка чёрная', unit: 'кг', issuedQty: '10', unitCost: '0', totalCost: '0' }] },
      },
    });
    await setSources('ISSUED', 'RECEIPT');
    const issued = await rebuild(orderId);
    expect(issued.materialLines[0].qty).toBe(10);
    // 25 440 / 58 = 438,6207 ₽/кг × 10 = 4 386,21.
    expect(issued.cost.materialsOwnRub).toBe(4386.21);
  });

  // ---------------------------------------------------------------------------
  // E1-7 — цена в USD
  // ---------------------------------------------------------------------------

  /** Все факты по потребности в USD; выдача — в рублях по курсу (так пишет авто-списание). */
  async function usdOrder(): Promise<{ orderId: string; needId: string }> {
    const orderId = await closedOrder();
    const n = await need(orderId, 'Кулирка чёрная', '47', '5', 'USD');
    const po = await purchaseOrder();
    const line = await poLine(po.id, n.id, '60', '5', { currency: 'USD' });
    await receipt(po.id, line.id, n.id, '58', '5', { currency: 'USD' });
    const issue = await t.prisma.materialIssue.create({
      data: {
        orderId, status: 'POSTED', totalCost: '24225', postedAt: new Date(),
        lines: { create: [{ workshopNeedId: n.id, description: 'Кулирка чёрная', unit: 'кг', issuedQty: '51', unitCost: '475', totalCost: '24225' }] },
      },
      include: { lines: true },
    });
    const ret = await t.prisma.materialIssueReturn.create({
      data: { materialIssueId: issue.id, orderId, status: 'POSTED', reason: 'остаток рулона', totalCost: '1900' },
    });
    await t.prisma.materialIssueReturnLine.create({
      data: {
        materialIssueReturnId: ret.id, materialIssueLineId: issue.lines[0].id, description: 'Кулирка чёрная',
        unit: 'кг', returnedQty: '4', unitCost: '475', totalCost: '1900',
      },
    });
    // Смета с курсом 95 — так её оставляет «Завершить расчёт»: план 47 × 5 × 95 = 22 325 ₽.
    await t.prisma.orderCostEstimate.create({
      data: { orderId, version: 1, status: 'COMPLETED', totalCostRub: '22325', usdRateRub: '95', completedAt: new Date() },
    });
    await t.prisma.order.update({ where: { id: orderId }, data: { costEstimateTotalRub: '22325', costEstimateVersion: 1 } });
    return { orderId, needId: n.id };
  }

  test('E1-7: цена в USD считается по курсу активной сметы на всех ступенях, а не обнуляется', async () => {
    const { orderId, needId } = await usdOrder();
    const lineOf = (doc: any) => doc.materialLines.find((l: any) => l.workshopNeedId === needId);

    // Списано × плановая котировка: 47 кг × 5 USD × 95 = 22 325 — ровно план документа.
    await setSources('ISSUED', 'PLANNED');
    let doc = await rebuild(orderId);
    expect(doc.cost.planTotalRub).toBe(22325);
    expect(lineOf(doc).qtyStep).toBe('ISSUED');
    expect(lineOf(doc).priceStep).toBe('PLANNED');
    expect(lineOf(doc).unitPriceRub).toBe(475);
    expect(lineOf(doc).totalRub).toBe(22325);
    expect(doc.cost.materialsOwnRub).toBe(22325);
    expect(doc.cost.warnings).not.toContain('MATERIAL_PRICE_UNKNOWN');
    expect(doc.cost.warnings).not.toContain('MATERIAL_PRICE_USD_NO_RATE');

    // Умолчания цеха: подтверждённая долларовая закупка — 47 × 475.
    await setSources('ISSUED_OR_CALCULATED', 'PURCHASE');
    doc = await rebuild(orderId);
    expect(lineOf(doc).priceStep).toBe('PURCHASE_CONFIRMED');
    expect(doc.cost.materialsOwnRub).toBe(22325);

    // Принято по цене приёмки: 58 × 475 = 27 550.
    await setSources('RECEIVED', 'RECEIPT');
    doc = await rebuild(orderId);
    expect(lineOf(doc).qty).toBe(58);
    expect(lineOf(doc).priceStep).toBe('RECEIPT');
    expect(doc.cost.materialsOwnRub).toBe(27550);
  });

  test('E1-7: без курса сметы строка в USD — не 0 ₽, а «сумма не посчитана» со своим кодом', async () => {
    const { orderId, needId } = await usdOrder();
    await t.prisma.orderCostEstimate.deleteMany({ where: { orderId } });

    await setSources('ISSUED', 'PLANNED');
    const doc = await rebuild(orderId);
    const line = doc.materialLines.find((l: any) => l.workshopNeedId === needId);
    expect(line.qty).toBe(47);
    expect(line.unitPriceRub).toBeNull();
    expect(line.priceStep).toBe('NONE');
    // Не ноль: цена есть, перевести её нечем — это другой сигнал, чем «цены нет».
    expect(line.totalRub).toBeNull();
    expect(doc.cost.warnings).toContain('MATERIAL_PRICE_USD_NO_RATE');
    expect(doc.cost.warnings).not.toContain('MATERIAL_PRICE_UNKNOWN');
    expect(doc.cost.materialsOwnRub).toBe(0);

    // Рублёвая строка без всякой цены по-прежнему «цены нет» — код не подменяется.
    await t.prisma.workshopNeed.update({ where: { id: needId }, data: { quotedPrice: null, quotedCurrency: 'RUB' } });
    const unknown = await rebuild(orderId);
    expect(unknown.cost.warnings).toContain('MATERIAL_PRICE_UNKNOWN');
    expect(unknown.cost.warnings).not.toContain('MATERIAL_PRICE_USD_NO_RATE');
    expect(unknown.materialLines.find((l: any) => l.workshopNeedId === needId).totalRub).toBe(0);
  });

  test('E1-7 (ревью): котировка в EUR — «валюта без курса», а не «нет курса USD»', async () => {
    const { orderId, needId } = await usdOrder();
    // Курс USD у сметы есть, но строка в EUR: её переводить нечем — и подпись про USD врала бы.
    await t.prisma.workshopNeed.update({ where: { id: needId }, data: { quotedCurrency: 'EUR' } });
    await setSources('ISSUED', 'PLANNED');
    const doc = await rebuild(orderId);
    const line = doc.materialLines.find((l: any) => l.workshopNeedId === needId);
    expect(line.unitPriceRub).toBeNull();
    expect(line.totalRub).toBeNull();
    expect(doc.cost.warnings).toContain('MATERIAL_PRICE_CURRENCY_UNSUPPORTED');
    expect(doc.cost.warnings).not.toContain('MATERIAL_PRICE_USD_NO_RATE');
    expect(doc.cost.warnings).not.toContain('MATERIAL_PRICE_UNKNOWN');
    expect(doc.cost.materialsOwnRub).toBe(0);
  });
});
