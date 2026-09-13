/**
 * МАТЕРИАЛ ПОД ERP В СЕБЕСТОИМОСТИ ЦЕХА — что происходит, когда факта ERP нет или он «отвязался».
 *
 * Аудит движка расчёта 13.09.2026, группа A1_costs_material:
 *
 *   D1-12 — у потребности под ERP единственный факт — ответ ERP (§0.3). FAILED / EMPTY / молчание
 *           — не расход, но и не ноль: раньше строка просто исчезала из документа выпуска, пока
 *           была хоть одна своя строка, и план→факт читал это как экономию. Теперь — строка 0
 *           с предупреждением и сигналы состояния ответов ERP (`ERP_CONSUMPTION_*`, `ERP_UNCOVERED_QTY`).
 *   D1-13 — после `erp-unlink` строка снова «своя», но списанное ERP по ней никуда не делось:
 *           движок считал норму И «Материал ERP без разбивки» — дважды. Force-пересчёт вдобавок
 *           отвязывал факт (`SetNull`), и план→факт терял его целиком — теперь пересчёт отбивается.
 *
 * Сид — как в `erp-material-consumption.test.ts`: заказ 10 шт, «Кулирка» под ERP (0,5 кг/шт → 5 кг,
 * erpUnitPriceRub 300), паспорта упаковываются «как цех», ответы ERP — настоящим `ack`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';
import { buildErpConsumptionService, buildErpProductionService, buildOrderFactCostService } from '../utils/erp-services';

const ERP_NOMENCLATURE = '11111111-1111-4111-8111-111111111111';
const ERP_UNIT = '22222222-2222-4222-8222-222222222222';
const ERP_SERIES = '33333333-3333-4333-8333-333333333333';

describeWithDb('integration — материал под ERP: сигналы без факта и отвязанный факт', () => {
  let t: TestApp;
  let seed: SeedResult;
  let manager: string;
  let erpToken: string;

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
    manager = loginAs(t, seed.employees['shop-chief']);
    // resetDatabase не трогает CompanySettings: автосписание ВЫКЛ (как на проде), оси по умолчанию
    // движка, отсечка очереди сдач ERP — чтобы документ уезжал в очередь.
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default', singleton: true,
        autoIssueMaterialsOnCutRelease: false,
        materialQtySource: 'ISSUED_OR_CALCULATED' as never,
        materialPriceSource: 'PURCHASE' as never,
        erpFinishedGoodsSince: new Date('2026-01-01T00:00:00.000Z'),
      },
      update: {
        autoIssueMaterialsOnCutRelease: false,
        materialQtySource: 'ISSUED_OR_CALCULATED' as never,
        materialPriceSource: 'PURCHASE' as never,
        erpFinishedGoodsSince: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    // Машинный токен ERP для ручек закупочного шва (ServiceToken не в списке truncate — хэш случайный).
    erpToken = `sew_a1_${randomBytes(12).toString('hex')}`;
    await t.prisma.serviceToken.create({
      data: {
        name: 'ERP (erp-material-fact-signals)',
        tokenHash: createHash('sha256').update(erpToken, 'utf8').digest('hex'),
        tokenPrefix: erpToken.slice(0, 10),
        roles: ['SHOP_MANAGER'],
        scopes: ['needs:read', 'needs:write', 'orders:read'],
      },
    });
  });

  // Слияние правок аудита 13.09: очереди ERP получили зависимость от ProductionDocumentsService (D1-2/D1-3) —
  // собираем их общим хелпером, как erp-production-document.test.ts.
  const factCost = () => buildOrderFactCostService(t);
  const consumptionQueue = () => buildErpConsumptionService(t);
  const productionQueue = () => buildErpProductionService(t);

  /** Заказ 10 шт: «Кулирка» (0,5 кг/шт) + «Нитки» (2 шт/шт, своя, чтобы список строк не был пуст); расчёт потребности. */
  async function orderWithNeeds(opts: { fromErp?: boolean; threads?: boolean } = {}) {
    const spec = await createSpecPattern(t, manager, {
      materialLines: [
        { name: 'Кулирка чёрная', unit: 'кг', qtyPerUnit: '0.5', materialRole: 'MAIN_FABRIC', colorRule: 'ORDER_COLOR' },
        ...(opts.threads === false
          ? []
          : [{ name: 'Нитки', unit: 'шт', qtyPerUnit: '2', materialRole: 'THREAD', colorRule: 'NO_COLOR' as const }]),
      ],
    });
    const created = await http()
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        patternItemId: spec.id,
        ...(opts.fromErp ? { erpCustomerOrderId: `erp-order-a1-${Date.now()}`, erpCustomerOrderNumber: 'ФС-00A1' } : {}),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId: string = created.body.id;
    const calc = await http().post(`/api/orders/${orderId}/workshop-needs/calculate`).set('Cookie', manager).send({});
    expect(calc.status, JSON.stringify(calc.body).slice(0, 300)).toBe(201);
    const fabric = await t.prisma.workshopNeed.findFirstOrThrow({ where: { orderId, materialRole: 'MAIN_FABRIC' } });
    expect(Number(fabric.calculatedQty)).toBe(5);
    const thread = await t.prisma.workshopNeed.findFirst({ where: { orderId, materialRole: 'THREAD' } });
    if (thread) {
      await t.prisma.workshopNeed.update({
        where: { id: thread.id },
        data: { quotedPrice: new Prisma.Decimal('5'), quotedCurrency: 'RUB' },
      });
    }
    return { orderId, fabricNeedId: fabric.id, threadNeedId: thread?.id ?? null };
  }

  /** «Под ERP» — как это делает закупочный шов (см. erp-material-consumption.test.ts). */
  async function underErp(needId: string, erpManagedAt = new Date('2026-04-14T00:00:00.000Z')) {
    await t.prisma.workshopNeed.update({
      where: { id: needId },
      data: {
        erpManagedAt, erpPurchaseOrderRef: 'УР-000001', erpNomenclatureId: ERP_NOMENCLATURE, erpUnitId: ERP_UNIT,
        erpUnitPriceRub: new Prisma.Decimal('300'), quotedPrice: new Prisma.Decimal('100'), quotedCurrency: 'RUB',
      },
    });
  }

  async function start(orderId: string) {
    const res = await http().post(`/api/orders/${orderId}/start`).set('Cookie', manager).send({});
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
  }

  /** Паспорт qtyCut шт, упакованный «как цех»: статус + событие PACKED (очередь смотрит на них). */
  async function packedPassport(orderId: string, qty: number, roll: string, packedAt?: Date): Promise<string> {
    const passport = await http()
      .post('/api/passports')
      .set('Cookie', manager)
      .send({ orderId, sizeId: seed.sizes.M, rollNumber: roll, cutDate: '2026-04-15T00:00:00.000Z', qtyCut: qty, cutterId: seed.employees.cutter.id });
    expect(passport.status, JSON.stringify(passport.body)).toBe(201);
    const passportId: string = passport.body.id;
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { status: 'PACKED', qtyGood: qty, erpSeriesId: ERP_SERIES, erpRollLabel: `Рулон ${roll}` },
    });
    await t.prisma.passportEvent.create({
      data: { passportId, type: 'PACKED', qty, ...(packedAt ? { createdAt: packedAt } : {}) },
    });
    return passportId;
  }

  const postedAck = (passportId: string, needId: string, qty: string, rub: string, uncovered = '0') => ({
    passport_id: passportId, state: 'POSTED', erp_document_ref: `СП-${passportId.slice(-4)}`, amount_rub: rub,
    uncovered_qty: uncovered, written_off_at: '2026-04-16T00:00:00.000Z',
    lines: [{ workshop_need_id: needId, description: 'Кулирка чёрная', unit: 'кг', qty, amount_rub: rub, uncovered_qty: uncovered }],
  });

  async function planFactDoc(orderId: string) {
    const res = await http().get(`/api/admin/production-cost/order/${orderId}/document`).set('Cookie', manager);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return res.body as { materials: Array<Record<string, any>>; totals: Record<string, string>; warnings: string[] };
  }

  // ---------------------------------------------------------------------------
  // D1-12 — потребность под ERP без POSTED-факта
  // ---------------------------------------------------------------------------

  test('D1-12: ERP ответила FAILED — строка под ERP едет нулём с предупреждением, а не исчезает', async () => {
    const { orderId, fabricNeedId, threadNeedId } = await orderWithNeeds();
    await underErp(fabricNeedId);
    await start(orderId);
    const p1 = await packedPassport(orderId, 4, 'R-A1');

    // Ровно такой ответ шлёт ERP при отказе (закрытый период, нет склада): паспорт уходит из очереди.
    const ack = await consumptionQueue().ack([
      { passport_id: p1, state: 'FAILED', amount_rub: '0', uncovered_qty: '0', lines: [], error: 'Период закрыт' } as any,
    ]);
    expect(ack.accepted).toBe(1);
    expect((await consumptionQueue().listPending(10)).count).toBe(0);

    const cost = await factCost().factCostForOrder(orderId, 4);
    // Своя строка «Нитки»: 20 × 0,4 × 5 = 40 ₽ — список не пуст, и раньше этого хватало, чтобы молчать.
    expect(cost.material_lines.find((l) => l.workshopNeedId === threadNeedId)?.totalRub).toBe(40);
    expect(cost.materials_own_rub).toBe(40);
    expect(cost.materials_erp_rub).toBe(0);
    const fabric = cost.material_lines.find((l) => l.workshopNeedId === fabricNeedId);
    expect(fabric).toBeTruthy();
    expect(fabric!.qty).toBe(0);
    expect(fabric!.qtyStep).toBe('ERP');
    expect(fabric!.totalRub).toBe(0);
    expect(cost.warnings).toContain('ERP_MATERIAL_FACT_MISSING');
    expect(cost.warnings).toContain('ERP_CONSUMPTION_FAILED');
    expect(cost.warnings).not.toContain('NO_MATERIAL_FACT');
  });

  test('D1-12: ERP ещё не ответила — ERP_CONSUMPTION_PENDING, без сигнала там, где ERP нечего списывать', async () => {
    const { orderId, fabricNeedId } = await orderWithNeeds();
    await underErp(fabricNeedId);
    await start(orderId);
    await packedPassport(orderId, 4, 'R-P1');

    const cost = await factCost().factCostForOrder(orderId, 4);
    expect(cost.warnings).toContain('ERP_CONSUMPTION_PENDING');
    expect(cost.warnings).toContain('ERP_MATERIAL_FACT_MISSING');
    expect(cost.material_lines.find((l) => l.workshopNeedId === fabricNeedId)?.qty).toBe(0);

    // Заказ без строк под ERP: ERP по нему не отвечает по устройству — сигналов нет.
    const own = await orderWithNeeds();
    await start(own.orderId);
    await packedPassport(own.orderId, 4, 'R-P2');
    const ownCost = await factCost().factCostForOrder(own.orderId, 4);
    expect(ownCost.warnings.some((w) => /^ERP_/u.test(w))).toBe(false);
  });

  test('D1-12: POSTED с uncovered_qty > 0 — факт в сумме, но с сигналом ERP_UNCOVERED_QTY', async () => {
    const { orderId, fabricNeedId } = await orderWithNeeds();
    await underErp(fabricNeedId);
    await start(orderId);
    const p1 = await packedPassport(orderId, 4, 'R-B1');
    expect((await consumptionQueue().ack([postedAck(p1, fabricNeedId, '2', '640', '1.5')])).accepted).toBe(1);

    const cost = await factCost().factCostForOrder(orderId, 4);
    const fabric = cost.material_lines.find((l) => l.workshopNeedId === fabricNeedId);
    expect(fabric?.qty).toBe(2);
    expect(fabric?.totalRub).toBe(640);
    expect(cost.materials_erp_rub).toBe(640);
    expect(cost.warnings).toContain('ERP_UNCOVERED_QTY');
    expect(cost.warnings).not.toContain('ERP_MATERIAL_FACT_MISSING');
  });

  test('D1-12: P1 FAILED + P2 POSTED — документ выпуска и очередь ERP несут предупреждение, а не «экономию»', async () => {
    const { orderId, fabricNeedId, threadNeedId } = await orderWithNeeds({ fromErp: true });
    await underErp(fabricNeedId);
    await start(orderId);
    const p1 = await packedPassport(orderId, 4, 'R-C1');
    const p2 = await packedPassport(orderId, 6, 'R-C2');
    const ack = await consumptionQueue().ack([
      { passport_id: p1, state: 'FAILED', amount_rub: '0', uncovered_qty: '0', lines: [] },
      postedAck(p2, fabricNeedId, '3', '960'),
    ]);
    expect(ack.accepted).toBe(2);

    const complete = await http().post(`/api/orders/${orderId}/complete`).set('Cookie', manager).send({});
    expect(complete.status, JSON.stringify(complete.body)).toBe(201);
    const pd = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    // Сумма — только реально списанное (P2), но документ говорит, что часть паспортов ERP не списала.
    expect(Number(pd.materialsOwnRub)).toBe(100);
    expect(Number(pd.materialsErpRub)).toBe(960);
    expect(pd.costWarnings).toContain('ERP_CONSUMPTION_FAILED');
    const snapshot = pd.materialsSnapshot as Array<Record<string, any>>;
    expect(snapshot.find((l) => l.workshopNeedId === fabricNeedId)?.totalRub).toBe(960);
    expect(snapshot.find((l) => l.workshopNeedId === threadNeedId)?.totalRub).toBe(100);

    const erpQueue = await productionQueue().listPending(10);
    expect(erpQueue.count).toBe(1);
    const erpCost = (erpQueue.items[0] as any).cost;
    expect(erpCost.materials_erp_rub).toBe(960);
    expect(erpCost.total_rub).toBe(1060);
    expect(erpCost.warnings).toContain('ERP_CONSUMPTION_FAILED');
  });

  test('D1-12: паспорт, упакованный до перевода под ERP, получает EMPTY — сигнал ERP_CONSUMPTION_EMPTY', async () => {
    const { orderId, fabricNeedId } = await orderWithNeeds();
    // Перевод под ERP датирован 15.04 12:00; P1 упакован до, P2 — после.
    await underErp(fabricNeedId, new Date('2026-04-15T12:00:00.000Z'));
    await start(orderId);
    const p1 = await packedPassport(orderId, 4, 'R-D1', new Date('2026-04-15T10:00:00.000Z'));
    const p2 = await packedPassport(orderId, 6, 'R-D2', new Date('2026-04-16T10:00:00.000Z'));
    const queue = await consumptionQueue().listPending(10);
    expect((queue.items.find((i: any) => i.passport_id === p1) as any).lines).toEqual([]);
    const ack = await consumptionQueue().ack([
      { passport_id: p1, state: 'EMPTY', amount_rub: '0', uncovered_qty: '0', lines: [] },
      postedAck(p2, fabricNeedId, '3', '960'),
    ]);
    expect(ack.accepted).toBe(2);

    const cost = await factCost().factCostForOrder(orderId, 10);
    expect(cost.materials_erp_rub).toBe(960);
    expect(cost.warnings).toContain('ERP_CONSUMPTION_EMPTY');
    expect(cost.warnings).not.toContain('ERP_CONSUMPTION_FAILED');
  });

  // ---------------------------------------------------------------------------
  // D1-13 — erp-unlink при живом факте ERP
  // ---------------------------------------------------------------------------

  /**
   * Потребность 5 кг по 100 ₽ → ERP взяла под свой ЗП по 320 ₽ (настоящей ручкой erp-link) →
   * запуск → 2 паспорта × 5 упакованы → ERP списала 2 × 2,5 кг × 320 = 1 600 ₽ → заказ закрыт.
   */
  async function orderWithErpFact(): Promise<{ orderId: string; needId: string }> {
    const { orderId, fabricNeedId } = await orderWithNeeds({ threads: false });
    const patched = await http()
      .patch(`/api/workshop-needs/${fabricNeedId}`)
      .set('Cookie', manager)
      .send({ quotedPrice: '100', quotedCurrency: 'RUB' });
    expect(patched.status, JSON.stringify(patched.body).slice(0, 300)).toBe(200);
    const link = await http()
      .post(`/api/workshop-needs/${fabricNeedId}/erp-link`)
      .set('Authorization', `Bearer ${erpToken}`)
      .send({
        status: 'ORDERED', erpPurchaseOrderId: 'po-a1-1', erpPurchaseOrderRef: 'ЗП-000113',
        erpNomenclatureId: ERP_NOMENCLATURE, erpUnitId: ERP_UNIT, erpUnitPriceRub: '320',
      });
    expect(link.status, JSON.stringify(link.body).slice(0, 300)).toBe(201);
    await start(orderId);
    for (const i of [0, 1]) {
      const p = await packedPassport(orderId, 5, `R-U-${i}`);
      expect((await consumptionQueue().ack([postedAck(p, fabricNeedId, '2.5', '800')])).accepted).toBe(1);
    }
    await t.prisma.order.update({
      where: { id: orderId },
      data: { status: 'DONE', completedAt: new Date('2026-09-03T10:00:00.000Z') },
    });
    return { orderId, needId: fabricNeedId };
  }

  test('D1-13: после erp-unlink факт ERP считается один раз — норма по строке с фактом не считается', async () => {
    const { orderId, needId } = await orderWithErpFact();

    // Контроль до unlink: только факт ERP.
    const before = await factCost().factCostForOrder(orderId, 10);
    expect(before.materials_erp_rub).toBe(1600);
    expect(before.materials_own_rub).toBe(0);
    expect(before.material_lines).toHaveLength(1);

    // ERP удалила черновик ЗП до прихода → отвязка настоящей машинной ручкой.
    const unlink = await http()
      .post(`/api/workshop-needs/${needId}/erp-unlink`)
      .set('Authorization', `Bearer ${erpToken}`)
      .send({ reason: 'Заказ ERP ЗП-000113 удалён' });
    expect(unlink.status, JSON.stringify(unlink.body).slice(0, 300)).toBe(201);
    expect((await t.prisma.workshopNeed.findUniqueOrThrow({ where: { id: needId } })).erpManagedAt).toBeNull();

    const after = await factCost().factCostForOrder(orderId, 10);
    expect(after.materials_erp_rub).toBe(1600);
    expect(after.materials_own_rub).toBe(0);
    expect(after.total_rub).toBe(1600);
    expect(after.material_lines).toHaveLength(1);
    expect(after.material_lines[0]!.workshopNeedId).toBe(needId);
    expect(after.material_lines[0]!.qtyStep).toBe('ERP');
    expect(after.material_lines[0]!.totalRub).toBe(1600);

    // Документ выпуска, пересобранный по фактам, — те же 1 600.
    const doc = await http().post(`/api/admin/orders/${orderId}/production-document`).set('Cookie', manager).send({});
    expect(doc.status, JSON.stringify(doc.body).slice(0, 300)).toBe(201);
    expect(doc.body.cost.materialsOwnRub).toBe(0);
    expect(doc.body.cost.materialsErpRub).toBe(1600);
    expect(doc.body.cost.totalRub).toBe(1600);

    // Свой расход, оформленный уже после отвязки, — считается, норма — по-прежнему нет.
    await t.prisma.materialIssue.create({
      data: {
        orderId, status: 'POSTED', totalCost: '200', postedAt: new Date(),
        lines: { create: [{ workshopNeedId: needId, description: 'Кулирка чёрная', unit: 'кг', issuedQty: '2', unitCost: '100', totalCost: '200' }] },
      },
    });
    const mixed = await factCost().factCostForOrder(orderId, 10);
    expect(mixed.materials_erp_rub).toBe(1600);
    const own = mixed.material_lines.find((l) => l.qtyStep === 'ISSUED');
    expect(own?.qty).toBe(2);
    expect(mixed.materials_own_rub).toBe(200);
    expect(mixed.material_lines.some((l) => l.qtyStep === 'CALCULATED')).toBe(false);
  });

  test('D1-13: force-пересчёт строки с фактом ERP отбивается — факт остаётся привязанным, план→факт его видит', async () => {
    const { orderId, needId } = await orderWithErpFact();
    const unlink = await http()
      .post(`/api/workshop-needs/${needId}/erp-unlink`)
      .set('Authorization', `Bearer ${erpToken}`)
      .send({ reason: 'Заказ ERP ЗП-000113 удалён' });
    expect(unlink.status, JSON.stringify(unlink.body).slice(0, 300)).toBe(201);

    const recalc = await http()
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({ force: true });
    expect(recalc.status, JSON.stringify(recalc.body).slice(0, 300)).toBe(409);
    expect(recalc.body.code).toBe('WORKSHOP_NEED_ERP_STATE');

    // Строка та же, факт ERP по-прежнему привязан, план→факт видит списанное.
    expect((await t.prisma.workshopNeed.findMany({ where: { orderId, materialRole: 'MAIN_FABRIC' } })).map((n) => n.id)).toEqual([needId]);
    expect(await t.prisma.erpMaterialConsumptionLine.count({ where: { workshopNeedId: needId } })).toBe(2);
    const pf = await planFactDoc(orderId);
    const row = pf.materials.find((m) => m.key === needId);
    expect(row?.issuedRub).toBe('1600.00');
    expect(pf.totals.issuedMaterialsRub).toBe('1600.00');

    // Добор (без удаления строк) гардом не блокируется — ему удалять нечего.
    const append = await http()
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({ appendMissing: true });
    expect([200, 201]).toContain(append.status);
  });
});
