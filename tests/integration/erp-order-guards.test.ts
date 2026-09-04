/**
 * Контур заказа, рождённого заказом покупателя ERP (`docs/kb/sewing.md` §0.10).
 *
 * Тираж и состав такого заказа приехали снаружи: в ERP его строки заблокированы, а реализация
 * ждёт ПОЛНОГО прихода. Поэтому в цехе он не правится ни одним путём и не закрывается
 * недовыпущенным — закрытие и есть сдача, а ответ ERP необратим: заказ исчезает из очереди
 * вместе с продукцией, которую уже не допоставить.
 *
 * Проверяем:
 *   1. второй заказ по той же паре «заказ покупателя + лекало» не создаётся (перепосланная
 *      отправка), а ВТОРОЕ лекало того же заказа покупателя уезжает своим заказом цеха;
 *   2. PATCH состава ERP-заказа отбивается;
 *   3. расцветки ERP-заказа не правятся (их окно — DRAFT/CALCULATION, ровно жизнь отправки);
 *   4. правка количества в производстве отбивается, а drawer заранее закрыт (`editable=false`);
 *   5. закрыть недовыпущенный ERP-заказ нельзя, полностью упакованный — можно;
 *   6. отмена ERP-заказа — не дело цеха;
 *   7. на собственных заказах цеха ничего из этого не действует;
 *   8. «Найти в цехе» отвечает по паре «заказ покупателя + лекало» — после молчания сети ERP
 *      спрашивает, а не шлёт второй POST.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import {
  loginAs,
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';
import { ErpOrderLookupController } from '../../apps/api/src/modules/integrations/erp-order-lookup.controller.js';

const ERP_ORDER = { erpCustomerOrderId: 'erp-co-1', erpCustomerOrderNumber: 'ФС-001922' };

describeWithDb('integration — заказ из ERP в цехе не правится и не закрывается недовыпущенным', () => {
  let t: TestApp;
  let seed: SeedResult;
  let manager: string;
  let routeTemplateId: string;

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
    manager = loginAs(t, seed.employees['shop-chief']);
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: `TPL-ERP-${Date.now()}`,
        name: 'ERP route',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.CUT_DIVISION.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 2, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    routeTemplateId = tpl.id;
  });

  async function createOrder(fromErp: boolean, qty = 10): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-09-01T00:00:00.000Z',
        productId: seed.product.id,
        routeTemplateId,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: qty }],
        ...(fromErp ? ERP_ORDER : {}),
      })
      .expect(201);
    return res.body.id as string;
  }

  async function start(orderId: string): Promise<void> {
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', manager)
      .expect(201);
  }

  /** Упаковать qty единиц размера M — ровно так очередь сдачи считает выпуск. */
  async function packed(orderId: string, qty: number): Promise<void> {
    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: `R-GUARD-${qty}`,
        cutDate: '2026-09-01T00:00:00.000Z',
        qtyCut: qty,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    await t.prisma.passport.update({
      where: { id: passport.body.id },
      data: { status: 'PACKED', qtyGood: qty },
    });
  }

  test('второй заказ по тому же заказу покупателя ERP не создаётся', async () => {
    await createOrder(true);
    const again = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-09-02T00:00:00.000Z',
        productId: seed.product.id,
        routeTemplateId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 3 }],
        ...ERP_ORDER,
      })
      .expect(409);
    expect(again.body.code).toBe('ERP_ORDER_ALREADY_LINKED');
    expect(await t.prisma.order.count()).toBe(1);
  });

  test('второе лекало того же заказа покупателя уезжает своим заказом цеха', async () => {
    const first = await createSpecPattern(t, manager, { name: 'Футболка Basic' });
    const second = await createSpecPattern(t, manager, { name: 'Худи Basic' });
    for (const patternItemId of [first.id, second.id]) {
      await request(t.app.getHttpServer())
        .post('/api/orders')
        .set('Cookie', manager)
        .send({
          orderDate: '2026-09-01T00:00:00.000Z',
          patternItemId,
          routeTemplateId,
          items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
          ...ERP_ORDER,
        })
        .expect(201);
    }
    expect(
      await t.prisma.order.count({ where: { erpCustomerOrderId: ERP_ORDER.erpCustomerOrderId } }),
    ).toBe(2);

    // А вот повтор ПО ТОМУ ЖЕ лекалу — это перепосланная отправка.
    const again = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-09-01T00:00:00.000Z',
        patternItemId: first.id,
        routeTemplateId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
        ...ERP_ORDER,
      })
      .expect(409);
    expect(again.body.code).toBe('ERP_ORDER_ALREADY_LINKED');
  });

  test('состав ERP-заказа через PATCH не меняется, у своего заказа — меняется', async () => {
    const fromErp = await createOrder(true);
    const own = await createOrder(false);

    const denied = await request(t.app.getHttpServer())
      .patch(`/api/orders/${fromErp}`)
      .set('Cookie', manager)
      .send({ items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }] })
      .expect(409);
    expect(denied.body.code).toBe('ERP_ORDER_PLAN_LOCKED');

    await request(t.app.getHttpServer())
      .patch(`/api/orders/${own}`)
      .set('Cookie', manager)
      .send({ items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }] })
      .expect(200);
    const item = await t.prisma.orderItem.findFirst({ where: { orderId: own } });
    expect(item?.qtyPlan).toBe(4);
  });

  test('расцветки ERP-заказа не правятся', async () => {
    const fromErp = await createOrder(true);
    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${fromErp}/colorways`)
      .set('Cookie', manager)
      .send({ color: 'Синий', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 5 }] })
      .expect(409);
    expect(res.body.code).toBe('ERP_ORDER_PLAN_LOCKED');
  });

  test('правка количества в производстве отбита, drawer закрыт заранее', async () => {
    const fromErp = await createOrder(true);
    await start(fromErp);

    const state = await request(t.app.getHttpServer())
      .get(`/api/orders/${fromErp}/amendments/quantities`)
      .set('Cookie', manager)
      .expect(200);
    expect(state.body.editable).toBe(false);

    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${fromErp}/amendments/quantities`)
      .set('Cookie', manager)
      .send({
        changes: [{ sizeId: seed.sizes.M, newQtyPlan: 6 }],
        reason: 'клиент передумал',
      })
      .expect(409);
    expect(res.body.code).toBe('ERP_ORDER_PLAN_LOCKED');
    const item = await t.prisma.orderItem.findFirst({ where: { orderId: fromErp } });
    expect(item?.qtyPlan).toBe(10);
  });

  test('недовыпущенный ERP-заказ не закрывается, полный — закрывается', async () => {
    const fromErp = await createOrder(true);
    await start(fromErp);
    await packed(fromErp, 8);

    const denied = await request(t.app.getHttpServer())
      .post(`/api/orders/${fromErp}/complete`)
      .set('Cookie', manager)
      .expect(409);
    expect(denied.body.code).toBe('ERP_ORDER_UNDERPRODUCED');
    expect(denied.body.message).toContain('8');
    expect(
      (await t.prisma.order.findUnique({ where: { id: fromErp } }))?.status,
    ).toBe('IN_PRODUCTION');

    await packed(fromErp, 2);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${fromErp}/complete`)
      .set('Cookie', manager)
      .expect(201);
    expect(
      (await t.prisma.order.findUnique({ where: { id: fromErp } }))?.status,
    ).toBe('DONE');
  });

  test('собственный заказ цеха закрывается недовыпущенным как раньше', async () => {
    const own = await createOrder(false);
    await start(own);
    await packed(own, 1);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${own}/complete`)
      .set('Cookie', manager)
      .expect(201);
    expect(
      (await t.prisma.order.findUnique({ where: { id: own } }))?.status,
    ).toBe('DONE');
  });

  test('«Найти в цехе»: заказ ищется по паре «заказ покупателя + лекало»', async () => {
    const first = await createSpecPattern(t, manager, { name: 'Футболка Basic' });
    const second = await createSpecPattern(t, manager, { name: 'Худи Basic' });
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-09-01T00:00:00.000Z',
        patternItemId: first.id,
        routeTemplateId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
        ...ERP_ORDER,
      })
      .expect(201);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lookup = new ErpOrderLookupController(t.prisma as any);
    const hit = await lookup.lookup(ERP_ORDER.erpCustomerOrderId, first.id);
    expect(hit.found).toBe(true);
    expect(hit.order?.id).toBe(created.body.id);

    // Второе лекало того же заказа ещё не уехало — «найти» нечего, и ERP отправит его заново.
    expect((await lookup.lookup(ERP_ORDER.erpCustomerOrderId, second.id)).found).toBe(false);
    expect((await lookup.lookup('erp-co-нет', first.id)).found).toBe(false);
  });

  test('отмена ERP-заказа — не дело цеха, свой отменяется', async () => {
    const fromErp = await createOrder(true);
    const own = await createOrder(false);

    const denied = await request(t.app.getHttpServer())
      .post(`/api/orders/${fromErp}/cancel`)
      .set('Cookie', manager)
      .expect(409);
    expect(denied.body.code).toBe('ERP_ORDER_PLAN_LOCKED');

    await request(t.app.getHttpServer())
      .post(`/api/orders/${own}/cancel`)
      .set('Cookie', manager)
      .expect(201);
    expect(
      (await t.prisma.order.findUnique({ where: { id: own } }))?.status,
    ).toBe('CANCELLED');
  });
});
