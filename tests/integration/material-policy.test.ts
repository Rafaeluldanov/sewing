/**
 * ПОЛИТИКА МАТЕРИАЛА — что попадает в документ выпуска при разных настройках.
 *
 * Один и тот же заказ прогоняется по всем комбинациям осей, потому что цена ошибки здесь —
 * не падение, а НЕПРАВИЛЬНОЕ ЧИСЛО в себестоимости, которое никто не заметит.
 *
 * Фабула фикстуры (числа выбраны так, чтобы каждая ступень давала свою сумму):
 *   норма          — 47 кг, плановая котировка 400 ₽;
 *   заказ поставщику — 60 кг, подтверждено по 430 ₽ (рулон целиком, как и бывает);
 *   приёмка         — 58 кг по 440 ₽;
 *   списано         — 51 кг, возвращён остаток 4 кг ⇒ нетто 47 кг.
 *
 * ⛔ Ключевая проверка — «заказано» НЕ равно «израсходовано»: при `ORDERED` в себестоимость
 * попадает остаток рулона, который ещё лежит на складе. Это законно только как ОСОЗНАННОЕ
 * решение по заказу (`ALL_PURCHASED`), и оба пути проверяются отдельно.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';

describeWithDb('integration — политика материала в документе выпуска', () => {
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

  /** Закрытый заказ на 10 шт с полным набором фактов по одной потребности. */
  async function orderWithMaterialFacts(): Promise<string> {
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
      })
      .expect(201);
    const orderId: string = order.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    // Потребность: норма 47 кг по плановой котировке 400 ₽.
    const need = await t.prisma.workshopNeed.create({
      data: {
        orderId,
        description: 'Кулирка чёрная',
        unit: 'кг',
        calculatedQty: '47',
        quotedPrice: '400',
        quotedCurrency: 'RUB',
        materialRole: 'MAIN_FABRIC',
      },
    });

    // Закупка: рулон 60 кг, подтверждён по 430 ₽.
    const supplier = await t.prisma.supplier.create({ data: { name: 'Ткани Опт' } });
    const po = await t.prisma.purchaseOrder.create({
      data: {
        number: `PO-${Date.now()}`,
        supplierId: supplier.id,
        supplierNameSnapshot: supplier.name,
        status: 'CONFIRMED',
      },
    });
    const poLine = await t.prisma.purchaseOrderLine.create({
      data: {
        purchaseOrderId: po.id,
        workshopNeedId: need.id,
        itemNameSnapshot: 'Кулирка чёрная',
        unitSnapshot: 'кг',
        qty: '60',
        price: '420',
        currency: 'RUB',
        confirmedQty: '60',
        confirmedPrice: '430',
      },
    });

    // Приёмка: приехало 58 кг по 440 ₽.
    const receipt = await t.prisma.purchaseReceipt.create({
      data: { number: `RC-${Date.now()}`, purchaseOrderId: po.id, status: 'POSTED' },
    });
    await t.prisma.purchaseReceiptLine.create({
      data: {
        purchaseReceiptId: receipt.id,
        purchaseOrderLineId: poLine.id,
        workshopNeedId: need.id,
        itemNameSnapshot: 'Кулирка чёрная',
        unitSnapshot: 'кг',
        receivedQty: '58',
        unit: 'кг',
        priceSnapshot: '440',
        currencySnapshot: 'RUB',
      },
    });

    // Расход: списан 51 кг, возвращён остаток 4 кг ⇒ нетто 47 кг.
    const issue = await t.prisma.materialIssue.create({
      data: {
        orderId,
        status: 'POSTED',
        totalCost: '20400',
        postedAt: new Date(),
        lines: {
          create: [
            {
              workshopNeedId: need.id,
              description: 'Кулирка чёрная',
              unit: 'кг',
              issuedQty: '51',
              unitCost: '400',
              totalCost: '20400',
            },
          ],
        },
      },
      include: { lines: true },
    });
    const ret = await t.prisma.materialIssueReturn.create({
      data: {
        materialIssueId: issue.id,
        orderId,
        status: 'POSTED',
        reason: 'остаток рулона',
        totalCost: '1600',
      },
    });
    await t.prisma.materialIssueReturnLine.create({
      data: {
        materialIssueReturnId: ret.id,
        materialIssueLineId: issue.lines[0].id,
        description: 'Кулирка чёрная',
        unit: 'кг',
        returnedQty: '4',
        unitCost: '400',
        totalCost: '1600',
      },
    });

    // Выпуск: паспорт на весь тираж, заказ закрыт → документ рождается сам.
    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-MP-1',
        cutDate: '2026-09-01T00:00:00.000Z',
        qtyCut: 10,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    await t.prisma.passport.update({
      where: { id: passport.body.id },
      data: { status: 'PACKED', qtyGood: 10 },
    });
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    return orderId;
  }

  async function setSources(qty: string, price: string): Promise<void> {
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        singleton: true,
        materialQtySource: qty as never,
        materialPriceSource: price as never,
      },
      update: {
        materialQtySource: qty as never,
        materialPriceSource: price as never,
      },
    });
  }

  /** Пересобрать документ кнопкой и вернуть его: настройка — не факт, сама пересборку не зовёт. */
  async function rebuild(orderId: string) {
    const res = await request(t.app.getHttpServer())
      .post(`/api/admin/orders/${orderId}/production-document`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    return res.body;
  }

  test('оси количества и цены дают разные суммы — и каждая цифра подписана', async () => {
    const orderId = await orderWithMaterialFacts();

    // 1. Списано × закупка — рекомендованное умолчание: 47 кг нетто × 430 ₽.
    await setSources('ISSUED_OR_CALCULATED', 'PURCHASE');
    let doc = await rebuild(orderId);
    expect(doc.cost.materialsOwnRub).toBe(20210);
    expect(doc.materialLines).toHaveLength(1);
    expect(doc.materialLines[0].qty).toBe(47);
    expect(doc.materialLines[0].qtyStep).toBe('ISSUED');
    expect(doc.materialLines[0].priceStep).toBe('PURCHASE_CONFIRMED');

    // 2. Сегодняшнее поведение: расход по плановой котировке.
    await setSources('ISSUED', 'PLANNED');
    doc = await rebuild(orderId);
    expect(doc.cost.materialsOwnRub).toBe(18800);
    expect(doc.materialLines[0].priceStep).toBe('PLANNED');

    // 3. Только норма: списаний как будто нет вовсе.
    await setSources('CALCULATED', 'PLANNED');
    doc = await rebuild(orderId);
    expect(doc.cost.materialsOwnRub).toBe(18800);
    expect(doc.materialLines[0].qtyStep).toBe('CALCULATED');

    // 4. Заказано: в себестоимость уехал остаток рулона — 60 кг вместо 47.
    await setSources('ORDERED', 'PURCHASE');
    doc = await rebuild(orderId);
    expect(doc.cost.materialsOwnRub).toBe(25800);
    expect(doc.materialLines[0].qtyStep).toBe('ORDERED');

    // 5. Принято: 58 кг по цене приёмки 440 ₽.
    await setSources('RECEIVED', 'RECEIPT');
    doc = await rebuild(orderId);
    expect(doc.cost.materialsOwnRub).toBe(25520);
    expect(doc.materialLines[0].qtyStep).toBe('RECEIVED');
    expect(doc.materialLines[0].priceStep).toBe('RECEIPT');
  });

  test('признание «вся закупка под заказ» перекрывает ось количества', async () => {
    const orderId = await orderWithMaterialFacts();
    await setSources('ISSUED_OR_CALCULATED', 'PURCHASE');

    let doc = await rebuild(orderId);
    expect(doc.cost.materialsOwnRub).toBe(20210);

    // Эксклюзивная ткань: остаток мёртвый и принадлежит этому тиражу.
    await t.prisma.order.update({
      where: { id: orderId },
      data: { materialRecognition: 'ALL_PURCHASED' },
    });
    doc = await rebuild(orderId);
    // Принято 58 кг × 430 ₽ — приёмка ближе к реальности, чем заказ.
    expect(doc.cost.materialsOwnRub).toBe(24940);
    expect(doc.materialLines[0].qtyStep).toBe('RECEIVED');
  });

  test('без списаний документ показывает расчёт по норме, а не ноль', async () => {
    const orderId = await orderWithMaterialFacts();
    // Убираем расход: так выглядят заказы, где списания просто не оформляли.
    await t.prisma.materialIssueReturnLine.deleteMany({});
    await t.prisma.materialIssueReturn.deleteMany({});
    await t.prisma.materialIssueLine.deleteMany({});
    await t.prisma.materialIssue.deleteMany({});

    await setSources('ISSUED', 'PURCHASE');
    let doc = await rebuild(orderId);
    // Строгий режим честно показывает ноль: расхода нет.
    expect(doc.cost.materialsOwnRub).toBe(0);

    await setSources('ISSUED_OR_CALCULATED', 'PURCHASE');
    doc = await rebuild(orderId);
    // Гибрид достаёт норму и помечает её оценкой — 47 кг × 430 ₽.
    expect(doc.cost.materialsOwnRub).toBe(20210);
    expect(doc.materialLines[0].qtyStep).toBe('CALCULATED');
    expect(doc.materialLines[0].priceStep).toBe('PURCHASE_CONFIRMED');
  });

  test('политика «материалы вне себестоимости» гасит и строки, и сумму', async () => {
    const orderId = await orderWithMaterialFacts();
    await setSources('ISSUED_OR_CALCULATED', 'PURCHASE');
    await t.prisma.order.update({
      where: { id: orderId },
      data: { materialsAndHardwareCostPolicy: 'EXCLUDE' },
    });
    const doc = await rebuild(orderId);
    expect(doc.cost.materialsOwnRub).toBe(0);
    expect(doc.materialLines).toHaveLength(0);
    expect(doc.cost.warnings).toContain('MATERIALS_EXCLUDED_BY_POLICY');
  });
});
