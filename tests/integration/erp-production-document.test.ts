/**
 * Сдача заказа в ERP: ДОКУМЕНТ ПРОИЗВОДСТВА, а не паспорт (решение владельца 04.09.2026).
 *
 * Паспорт — документ ЦЕХА: он рождается на раскрое и закрывается упаковкой. В учёте предприятия
 * его место — основание: паспорта собираются в документ производства заказа, и уже этот документ
 * приходует продукцию на склад ERP. Отсюда проверки:
 *
 *   1. без даты отсечки очередь ПУСТА — иначе первый опрос отдал бы весь архив сдач;
 *   2. в очередь попадают ТОЛЬКО закрытые заказы, рождённые заказом покупателя ERP;
 *   3. заказ отдаётся ОДНОЙ строкой очереди со строками по цвету и размеру (Σ по паспортам);
 *   4. ответ ERP убирает заказ из очереди навсегда, повторный ответ его заменяет;
 *   5. плохой элемент ответа не роняет весь пакет;
 *   6. собственный заказ цеха ответа не принимает — ERP по нему ничего не решает.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';
import { ErpProductionService } from '../../apps/api/src/modules/integrations/erp-production.service.js';
import { ErpOrderCostService } from '../../apps/api/src/modules/integrations/erp-order-cost.service.js';
import { PassportRealCostService } from '../../apps/api/src/modules/costs/passport-real-cost.service.js';

describeWithDb('integration — сдача заказа цеха уходит в ERP документом производства', () => {
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
    cookies = { manager: loginAs(t, seed.employees['shop-chief']) };
  });

  /** Закрытый заказ с двумя упакованными паспортами одного размера. */
  async function closedOrder(opts: { fromErp?: boolean } = {}): Promise<string> {
    const spec = await createSpecPattern(t, cookies.manager, {
      materialLines: [
        {
          name: 'Кулирка чёрная',
          unit: 'кг',
          qtyPerUnit: '0.5',
          materialRole: 'MAIN_FABRIC',
          colorRule: 'ORDER_COLOR',
        },
      ],
    });
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-09-01T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        patternItemId: spec.id,
        ...(opts.fromErp === false
          ? {}
          : { erpCustomerOrderId: 'erp-order-1', erpCustomerOrderNumber: 'ФС-001922' }),
      })
      .expect(201);
    const orderId: string = order.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    for (const [i, qty] of [4, 6].entries()) {
      const passport = await request(t.app.getHttpServer())
        .post('/api/passports')
        .set('Cookie', cookies.manager)
        .send({
          orderId,
          sizeId: seed.sizes.M,
          rollNumber: `R-PD-${i}`,
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
    await t.prisma.order.update({
      where: { id: orderId },
      data: { status: 'DONE', completedAt: new Date('2026-09-03T10:00:00.000Z') },
    });
    return orderId;
  }

  /** Сервис на тестовом prisma: у DI-версии свой клиент, требующий TenantContext HTTP-запроса. */
  function service(): ErpProductionService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma = t.prisma as any;
    return new ErpProductionService(prisma, new ErpOrderCostService(prisma, new PassportRealCostService(prisma)));
  }

  async function setSince(value: Date | null): Promise<void> {
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', singleton: true, erpFinishedGoodsSince: value },
      update: { erpFinishedGoodsSince: value },
    });
  }

  test('карточка заказа отдаёт связь с ERP, дату сдачи и ответ ERP', async () => {
    const orderId = await closedOrder();
    const res = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    // Раньше ERP этих полей не получала и спрашивала о связи свою же таблицу.
    expect(res.body.erpCustomerOrderId).toBe('erp-order-1');
    expect(res.body.erpCustomerOrderNumber).toBe('ФС-001922');
    expect(res.body.completedAt).toBeTruthy();
    expect(res.body.erpProduction).toBeNull();

    await t.prisma.erpProductionDocument.create({
      data: {
        orderId, state: 'POSTED', erpDocumentNumber: 'ВЦ-000001', qtyGood: 10,
        postedAt: new Date('2026-09-04T10:00:00.000Z'),
      },
    });
    const after = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(after.body.erpProduction?.erpDocumentNumber).toBe('ВЦ-000001');
    expect(after.body.erpProduction?.qtyGood).toBe(10);
  });

  test('в очередь сдачи едет брак по причинам, а не только сумма', async () => {
    const orderId = await closedOrder();
    await setSince(new Date('2026-09-01T00:00:00.000Z'));
    const type = await t.prisma.defectType.create({
      data: { code: `DEF-${Date.now()}`, name: 'Пропуск строчки', sortOrder: 1 },
    });
    const passport = await t.prisma.passport.findFirst({ where: { orderId } });
    await t.prisma.passportDefect.create({
      data: { passportId: passport!.id, defectTypeId: type.id, qty: 2, comment: 'на рукаве' },
    });

    const queue = await service().listPending(10);
    const line = (queue.items[0].lines as Array<Record<string, unknown>>)[0];
    const defects = line.defects as Array<Record<string, unknown>>;
    expect(defects).toHaveLength(1);
    expect(defects[0].name).toBe('Пропуск строчки');
    expect(defects[0].qty).toBe(2);
    expect(defects[0].comment).toBe('на рукаве');
  });

  test('без даты отсечки очередь пуста — архив сдач в ERP не уезжает', async () => {
    await closedOrder();
    await setSince(null);
    const queue = await service().listPending(10);
    expect(queue.count).toBe(0);
  });

  test('сданный заказ отдаётся ОДНОЙ строкой со строками по цвету и размеру', async () => {
    const orderId = await closedOrder();
    await setSince(new Date('2026-08-01T00:00:00.000Z'));
    const queue = await service().listPending(10);
    expect(queue.count).toBe(1);
    const item = queue.items[0] as Record<string, any>;
    expect(item.order_id).toBe(orderId);
    expect(item.erp_customer_order_number).toBe('ФС-001922');
    // Два паспорта одного размера — ОДНА строка документа: паспорт основание, а не документ.
    expect(item.lines).toHaveLength(1);
    expect(item.lines[0].qty_good).toBe(10);
    expect(item.lines[0].size_code).toBe('M');
    expect(item.lines[0].passports).toHaveLength(2);
    expect(item.qty_good).toBe(10);
  });

  test('собственный заказ цеха в очередь не попадает', async () => {
    await closedOrder({ fromErp: false });
    await setSince(new Date('2026-08-01T00:00:00.000Z'));
    const queue = await service().listPending(10);
    expect(queue.count).toBe(0);
  });

  test('ответ ERP убирает заказ из очереди, повтор заменяет запись', async () => {
    const orderId = await closedOrder();
    await setSince(new Date('2026-08-01T00:00:00.000Z'));
    const svc = service();
    const first = await svc.ack([
      { order_id: orderId, state: 'POSTED', erp_document_number: 'ШВЦ-000001', qty_good: 10 },
    ]);
    expect(first.accepted).toBe(1);
    expect((await svc.listPending(10)).count).toBe(0);
    const row = await t.prisma.erpProductionDocument.findUnique({ where: { orderId } });
    expect(row?.erpDocumentNumber).toBe('ШВЦ-000001');
    await svc.ack([{ order_id: orderId, state: 'REVERSED', error: 'сторно' }]);
    const again = await t.prisma.erpProductionDocument.findUnique({ where: { orderId } });
    expect(again?.state).toBe('REVERSED');
    expect(again?.error).toBe('сторно');
  });

  test('плохой элемент ответа не роняет пакет и не принимается по чужому заказу', async () => {
    const orderId = await closedOrder();
    const own = await closedOrder({ fromErp: false });
    const svc = service();
    const res = await svc.ack([
      { state: 'POSTED' },
      { order_id: 'нет-такого', state: 'POSTED' },
      { order_id: own, state: 'POSTED' },
      { order_id: orderId, state: 'POSTED', qty_good: 10 },
    ]);
    expect(res.accepted).toBe(1);
    expect(res.skipped).toHaveLength(3);
    expect(await t.prisma.erpProductionDocument.count()).toBe(1);
  });
});
