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
 *
 * Себестоимость сдачи (08.09.2026) — четыре грабли, каждая теряла деньги молча:
 *   7. списание, оформленное на заказ без паспорта, в сумму не попадало;
 *   8. политика «материалы вне себестоимости» обнуляла свой материал, но не материал ERP;
 *   9. прочие расходы в валюте складывались с рублёвыми как рубли;
 *  10. подкрой (повременная доплата по заказу) не считался вовсе;
 *  11. неподтверждённая сдельная не была видна — сумма молча занижена на незакрытую коробку.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';
import { ErpProductionService } from '../../apps/api/src/modules/integrations/erp-production.service.js';
import { OrderFactCostService } from '../../apps/api/src/modules/costs/order-fact-cost.service.js';
import { PassportRealCostService } from '../../apps/api/src/modules/costs/passport-real-cost.service.js';
import { OrderMaterialCostService } from '../../apps/api/src/modules/costs/order-material-cost.service.js';

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
    // Закрываем заказ настоящей ручкой: документ выпуска рождается в транзакции закрытия,
    // и подмена статуса через prisma оставила бы очередь пустой — как это и было в проде.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    return orderId;
  }

  /** Сервис на тестовом prisma: у DI-версии свой клиент, требующий TenantContext HTTP-запроса. */
  function service(): ErpProductionService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma = t.prisma as any;
    return new ErpProductionService(prisma, new OrderFactCostService(
      prisma,
      new PassportRealCostService(prisma),
      new OrderMaterialCostService(prisma),
    ));
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
    // Единица выгрузки — ДОКУМЕНТ: у него свой номер, он же ключ идемпотентности у ERP.
    expect(String(item.document_number)).toMatch(/^ПР-\d{8}-\d{4}$/);
    expect(item.ready_at).toBeTruthy();
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

  test('ответ ERP — журнал, а не гейт: документ из выгрузки не исчезает', async () => {
    const orderId = await closedOrder();
    await setSince(new Date('2026-08-01T00:00:00.000Z'));
    const svc = service();
    const first = await svc.ack([
      { order_id: orderId, state: 'POSTED', erp_document_number: 'ШВЦ-000001', qty_good: 10 },
    ]);
    expect(first.accepted).toBe(1);
    // Согласования нет: выгрузка идёт по курсору готовности, и ответ ERP на неё не влияет.
    // Раньше здесь было `0` — именно этот гейт и убрали.
    expect((await svc.listPending(10)).count).toBe(1);
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

  // ---------------------------------------------------------------------------
  // СЕБЕСТОИМОСТЬ СДАЧИ
  // ---------------------------------------------------------------------------

  /** Себестоимость сдачи по всем упакованным паспортам заказа — как её считает очередь. */
  async function costOf(orderId: string) {
    const passports = await t.prisma.passport.findMany({
      where: { orderId, status: 'PACKED' },
      select: { id: true, qtyGood: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma = t.prisma as any;
    return new OrderFactCostService(
      prisma,
      new PassportRealCostService(prisma),
      new OrderMaterialCostService(prisma),
    ).factCostForOrder(
      orderId,
      passports.reduce((sum, p) => sum + (p.qtyGood ?? 0), 0),
    );
  }

  test('списание на заказ БЕЗ паспорта входит в себестоимость, возврат по нему вычитается', async () => {
    const orderId = await closedOrder();
    // Ручное списание менеджера: паспорт не указан — документ на заказ целиком.
    const issue = await t.prisma.materialIssue.create({
      data: {
        orderId, status: 'POSTED', totalCost: '1000', postedAt: new Date(),
        lines: {
          create: [{
            description: 'Кулирка чёрная', unit: 'кг',
            issuedQty: '10', unitCost: '100', totalCost: '1000',
          }],
        },
      },
    });
    const only = await costOf(orderId);
    expect(only.materials_own_rub).toBe(1000);

    await t.prisma.materialIssueReturn.create({
      data: {
        materialIssueId: issue.id, orderId, status: 'POSTED',
        reason: 'остаток рулона', totalCost: '250',
      },
    });
    const net = await costOf(orderId);
    // Возврат обязан фильтроваться той же выборкой, иначе минус потеряется вместе с плюсом.
    expect(net.materials_own_rub).toBe(750);
    expect(net.warnings).not.toContain('NO_MATERIAL_FACT');
  });

  test('работа по паспорту, не дошедшему до упаковки, из трат не выпадает', async () => {
    const orderId = await closedOrder();
    const operationId = Object.values(seed.operations)[0].id;
    // Паспорт отменён (весь тираж в брак), но люди по нему работали и деньги получили.
    const cancelled = await t.prisma.passport.create({
      data: {
        number: `P-CANCELLED-${Date.now()}`, qrCode: `QR-CANCELLED-${Date.now()}`,
        orderId, productId: seed.product.id, sizeId: seed.sizes.M, color: 'Чёрный',
        status: 'CANCELLED', qtyPlan: 3, qtyCut: 3, qtyGood: 0,
        rollNumber: 'R-PD-X', cutDate: new Date('2026-09-01T00:00:00.000Z'),
        cutterId: seed.employees.cutter.id, creatorId: seed.employees['shop-chief'].id,
      },
    });
    await t.prisma.operationEntry.create({
      data: {
        passportId: cancelled.id, operationId, employeeId: seed.employees.cutter.id,
        qty: 3, ratePerUnit: '10', amount: '30', status: 'APPROVED',
      },
    });
    const cost = await costOf(orderId);
    expect(cost.piecework_rub).toBe(30);
    expect(cost.total_rub).toBe(30);
  });

  test('политика «материалы вне себестоимости» обнуляет и материал ERP', async () => {
    const orderId = await closedOrder();
    const passport = await t.prisma.passport.findFirst({ where: { orderId } });
    await t.prisma.erpMaterialConsumption.create({
      data: { passportId: passport!.id, orderId, state: 'POSTED', amountRub: '4000' },
    });
    const before = await costOf(orderId);
    expect(before.materials_erp_rub).toBe(4000);

    await t.prisma.order.update({
      where: { id: orderId },
      data: { materialsAndHardwareCostPolicy: 'EXCLUDE' },
    });
    const after = await costOf(orderId);
    // Политика — про материал, а не про то, чей склад.
    expect(after.materials_erp_rub).toBe(0);
    expect(after.materials_own_rub).toBe(0);
    expect(after.warnings).toContain('MATERIALS_EXCLUDED_BY_POLICY');
  });

  test('прочие расходы в валюте не складываются с рублёвыми', async () => {
    const orderId = await closedOrder();
    await t.prisma.orderExtraCost.createMany({
      data: [
        { orderId, description: 'Доставка', amount: '500', currency: 'RUB', includeInCostPrice: true },
        { orderId, description: 'Фурнитура из Китая', amount: '100', currency: 'USD', includeInCostPrice: true },
        { orderId, description: 'Не в себестоимость', amount: '900', currency: 'RUB', includeInCostPrice: false },
      ],
    });
    const cost = await costOf(orderId);
    expect(cost.other_rub).toBe(500);
    // Пропущенный расход должен быть слышен: конвертации на MVP нет.
    expect(cost.warnings).toContain('EXTRA_COSTS_NON_RUB_SKIPPED');
  });

  test('подкрой входит в себестоимость отдельным компонентом', async () => {
    const orderId = await closedOrder();
    await t.prisma.recutSession.create({
      data: {
        orderId, employeeId: seed.employees.cutter.id, status: 'DONE',
        startedAt: new Date('2026-09-02T08:00:00.000Z'),
        endedAt: new Date('2026-09-02T10:00:00.000Z'),
        ratePerHour: '150', workedSeconds: 7200, amount: '300',
      },
    });
    // Незавершённая сессия — не расход: денег по ней ещё нет.
    await t.prisma.recutSession.create({
      data: {
        orderId, employeeId: seed.employees.cutter.id, status: 'ACTIVE',
        startedAt: new Date('2026-09-02T11:00:00.000Z'), ratePerHour: '150',
      },
    });
    const cost = await costOf(orderId);
    expect(cost.recut_rub).toBe(300);
    expect(cost.total_rub).toBe(300);
  });

  test('неподтверждённая сдельная видна отдельно и в сумму не входит', async () => {
    const orderId = await closedOrder();
    const passports = await t.prisma.passport.findMany({ where: { orderId } });
    const operationId = Object.values(seed.operations)[0].id;
    await t.prisma.operationEntry.create({
      data: {
        passportId: passports[0].id, operationId, employeeId: seed.employees.cutter.id,
        qty: 4, ratePerUnit: '10', amount: '40', status: 'APPROVED',
      },
    });
    await t.prisma.operationEntry.create({
      data: {
        passportId: passports[1].id, operationId, employeeId: seed.employees.cutter.id,
        qty: 6, ratePerUnit: '10', amount: '60', status: 'PENDING_RELEASE',
      },
    });
    const cost = await costOf(orderId);
    expect(cost.piecework_rub).toBe(40);
    expect(cost.piecework_pending_rub).toBe(60);
    // Обещание — не трата: в сумме только подтверждённое, но разрыв виден.
    expect(cost.total_rub).toBe(40);
    expect(cost.warnings).toContain('PIECEWORK_PENDING');
  });
});
