/**
 * Цена заказа поставщику ERP (`WorkshopNeed.erpUnitPriceRub`) в смете себестоимости.
 * Регрессия на аудит движка расчёта 13.09.2026 (E1-1, E1-10, N2-5).
 *
 *   1. E1-1: `erp-link` с ценой ERP меняет цену, которую смета предпочитает `quotedPrice`
 *      (`assembleEstimatePlan`), поэтому смета и `Order.costEstimateTotalRub` обязаны догнать
 *      её СРАЗУ (`domain.md §1.5`: ручка, меняющая источник сметы, заканчивается
 *      `syncAfterNeedsChange`). `erp-unlink` — симметрично: цена ERP снята → снова
 *      `quotedPrice`. Раньше обе ручки молчали, и итог менялся «сам» от любой соседней правки.
 *   2. E1-10: `erpUnitPriceRub = "0"` (строка ЗП ERP ещё без цены) — это «цена не задана»,
 *      а не «главнее плановой»: нормализуется в `null`, смета и план→факт берут `quotedPrice`.
 *      Раньше `Prisma.Decimal(0)` был истинен → «Цена должна быть > 0» → отметка «устарела»
 *      при валидной цене закупщика цеха, а документ показывал план строки 0 ₽.
 *   3. N2-5: `quotedPrice = 0` по-прежнему проходит PATCH («бесплатный материал» в Zod) и
 *      по-прежнему отвергается сметой — решение владельца «цена 0 = бесплатно или запрет» НЕ
 *      принято, семантика не менялась. Меняется только причина: она обязана подсказывать
 *      выход (цена > 0 / политика / гашение строки), а не повторять условие гарда.
 */
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';

describeWithDb('integration — цена ERP в смете себестоимости (E1-1, E1-10, N2-5)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookie: string;
  let erpToken: string;

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
    // ServiceToken не в списке truncate, tokenHash @unique — токен случайный на тест.
    erpToken = `sew_erpprice_${randomBytes(12).toString('hex')}`;
    await t.prisma.serviceToken.create({
      data: {
        name: 'ERP (erp-price test)',
        tokenHash: createHash('sha256').update(erpToken, 'utf8').digest('hex'),
        tokenPrefix: erpToken.slice(0, 10),
        roles: ['SHOP_MANAGER'],
        scopes: ['needs:read', 'needs:write', 'orders:read'],
      },
    });
  });

  const api = () => request(t.app.getHttpServer());

  /** Заказ в CALCULATION с одной строкой потребности «Нитки» (1 м/шт × 4 шт = 4 м). */
  async function prepareCalculationOrder(): Promise<{ orderId: string; needId: string }> {
    const spec = await createSpecPattern(t, cookie, {
      name: 'erp-price спец',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1' }],
    });
    const order = await api()
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        clientId: seed.client.id,
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
        patternItemId: spec.id,
      })
      .expect(201);
    const orderId = order.body.id as string;
    await api()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
    const needs = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    expect(needs).toHaveLength(1);
    return { orderId, needId: needs[0]!.id };
  }

  /** Строка 100 м × 500 ₽ (RUB) и зафиксированная смета на 50 000 ₽. */
  async function completedAt50k(): Promise<{ orderId: string; needId: string }> {
    const { orderId, needId } = await prepareCalculationOrder();
    await api()
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookie)
      .send({ purchaseQty: '100', quotedPrice: '500', quotedCurrency: 'RUB' })
      .expect(200);
    const est = await api()
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
    expect(Number(est.body.totalCostRub)).toBe(50_000);
    return { orderId, needId };
  }

  async function orderMoney(orderId: string) {
    const o = await t.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        status: true,
        costEstimateTotalRub: true,
        costEstimateVersion: true,
        costEstimateStaleAt: true,
        costEstimateStaleReason: true,
      },
    });
    return {
      status: o.status,
      total: o.costEstimateTotalRub == null ? null : Number(o.costEstimateTotalRub),
      version: o.costEstimateVersion,
      stale: o.costEstimateStaleAt != null,
      reason: o.costEstimateStaleReason,
    };
  }

  function erpLink(needId: string, body: Record<string, unknown>) {
    return api()
      .post(`/api/workshop-needs/${needId}/erp-link`)
      .set('Authorization', `Bearer ${erpToken}`)
      .send({
        status: 'ORDERED',
        erpPurchaseOrderId: 'po-erp-price-1',
        erpPurchaseOrderRef: 'ЗП-000001',
        erpNomenclatureId: '11111111-1111-4111-8111-111111111111',
        erpUnitId: '22222222-2222-4222-8222-222222222222',
        ...body,
      });
  }

  test('E1-1: erp-link с ценой ERP пересчитывает смету сразу, erp-unlink возвращает цену закупщика', async () => {
    const { orderId, needId } = await completedAt50k();

    // ERP заводит ЗП по 450 ₽/м — цена ERP главнее плановой, смета обязана догнать без клика.
    const link = await erpLink(needId, { erpUnitPriceRub: '450' }).expect(201);
    expect(link.body.erpUnitPriceRub).toBe('450');
    const afterLink = await orderMoney(orderId);
    expect(afterLink.total).toBe(45_000);
    expect(afterLink.version).toBe(2);
    expect(afterLink.stale).toBe(false);

    // Несвязанная правка (комментарий) больше ничего «внезапно» не меняет: план тот же —
    // новой версии сметы нет.
    await api()
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookie)
      .send({ comment: 'звонил поставщику' })
      .expect(200);
    const afterComment = await orderMoney(orderId);
    expect(afterComment.total).toBe(45_000);
    expect(afterComment.version).toBe(2);

    // ERP отказалась от потребности — цена ERP снята, смета снова по quotedPrice, сразу.
    await api()
      .post(`/api/workshop-needs/${needId}/erp-unlink`)
      .set('Authorization', `Bearer ${erpToken}`)
      .send({ reason: 'заказ отменён' })
      .expect(201);
    const afterUnlink = await orderMoney(orderId);
    expect(afterUnlink.total).toBe(50_000);
    expect(afterUnlink.version).toBe(3);
    expect(afterUnlink.stale).toBe(false);

    // Активная смета — одна, и её строка несёт цену закупщика.
    const active = await t.prisma.orderCostEstimate.findMany({
      where: { orderId, status: 'COMPLETED' },
      include: { lines: true },
    });
    expect(active).toHaveLength(1);
    expect(Number(active[0]!.lines[0]!.quotedPrice)).toBe(500);
  });

  test('E1-1: erp-link без активной сметы (CALCULATION) не ставит отметку «устарела»', async () => {
    const { orderId, needId } = await prepareCalculationOrder();
    await api()
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookie)
      .send({ purchaseQty: '100', quotedPrice: '500', quotedCurrency: 'RUB' })
      .expect(200);
    await erpLink(needId, { erpUnitPriceRub: '450' }).expect(201);
    const money = await orderMoney(orderId);
    expect(money.status).toBe('CALCULATION');
    expect(money.total).toBeNull();
    expect(money.stale).toBe(false);
  });

  test('E1-10: erpUnitPriceRub = "0" — цена не задана: null в строке, смета и план→факт берут quotedPrice', async () => {
    const { orderId, needId } = await completedAt50k();

    // Строка ЗП ERP ещё без цены уезжает как "0" — Zod пропускает, ноль нормализуется в null.
    const link0 = await erpLink(needId, { erpUnitPriceRub: '0' }).expect(201);
    expect(link0.body.erpUnitPriceRub).toBeNull();
    expect(link0.body.erpManagedAt).not.toBeNull();
    const row = await t.prisma.workshopNeed.findUniqueOrThrow({ where: { id: needId } });
    expect(row.erpUnitPriceRub).toBeNull();

    // Смета — по цене закупщика цеха, без отметки «устарела» и без ложного «Цена должна быть > 0».
    const afterZero = await orderMoney(orderId);
    expect(afterZero.total).toBe(50_000);
    expect(afterZero.stale).toBe(false);
    expect(afterZero.reason).toBeNull();

    // Соседняя правка (она тянет автопересчёт) тоже не роняет смету в stale.
    await api()
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookie)
      .send({ comment: 'после нуля' })
      .expect(200);
    const afterComment = await orderMoney(orderId);
    expect(afterComment.total).toBe(50_000);
    expect(afterComment.stale).toBe(false);

    // Документ план→факт: план строки — 100 × 500, а не 100 × 0.
    const doc = await api()
      .get(`/api/admin/production-cost/order/${orderId}/document`)
      .set('Cookie', cookie)
      .expect(200);
    const material = (doc.body.materials as { key: string; planRub: string | null }[]).find(
      (m) => m.key === needId,
    );
    expect(material).toBeDefined();
    expect(Number(material!.planRub)).toBe(50_000);

    // Позже ERP проставила цену — она главнее и смета догоняет (тот же ЗП).
    await erpLink(needId, { erpUnitPriceRub: '450' }).expect(201);
    expect((await orderMoney(orderId)).total).toBe(45_000);
    // И обратно: цену в ERP обнулили — снова цена закупщика, а не 0 ₽.
    await erpLink(needId, { erpUnitPriceRub: '0' }).expect(201);
    expect((await orderMoney(orderId)).total).toBe(50_000);
  });

  test('E1-10: план→факт без сметы — цена ERP "0" не даёт план 0 ₽', async () => {
    const { orderId, needId } = await prepareCalculationOrder();
    await api()
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookie)
      .send({ purchaseQty: '100', quotedPrice: '500', quotedCurrency: 'RUB' })
      .expect(200);
    await erpLink(needId, { erpUnitPriceRub: '0' }).expect(201);
    const doc = await api()
      .get(`/api/admin/production-cost/order/${orderId}/document`)
      .set('Cookie', cookie)
      .expect(200);
    const material = (
      doc.body.materials as { key: string; planRub: string | null; planSource: string }[]
    ).find((m) => m.key === needId);
    expect(material).toBeDefined();
    expect(material!.planSource).toBe('WORKSHOP_NEED');
    expect(Number(material!.planRub)).toBe(50_000);
  });

  test('N2-5: quotedPrice = 0 проходит PATCH, смета отвергает с понятной причиной (семантика не менялась)', async () => {
    const { orderId, needId } = await prepareCalculationOrder();
    const patched = await api()
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookie)
      .send({ purchaseQty: '100', quotedPrice: '0', quotedCurrency: 'RUB' })
      .expect(200);
    // Zod по-прежнему принимает 0 — решение владельца по «бесплатному материалу» не принято.
    expect(patched.body.quotedPrice).toBe('0');

    const r = await api()
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookie)
      .send({});
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('ORDER_CALCULATION_INCOMPLETE');
    const message = String(r.body.message);
    expect(message).toContain('«Нитки»');
    // Причина подсказывает выход, а не повторяет условие гарда.
    expect(message).toContain('Цена 0');
    expect(message).toContain('укажите цену больше 0');
    expect(message).toContain('Не учитывать материалы и фурнитуру');
    expect(message).not.toContain('Цена должна быть > 0');

    // Заказ остаётся в CALCULATION, сметы нет.
    const money = await orderMoney(orderId);
    expect(money.status).toBe('CALCULATION');
    expect(money.total).toBeNull();
  });
});
