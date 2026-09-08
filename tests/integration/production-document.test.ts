/**
 * ДОКУМЕНТ ВЫПУСКА ПО ЗАКАЗУ — он собирается сам, и проверять надо именно это:
 *
 *   1. рождается ВМЕСТЕ с закрытием заказа: номер, шапка, строки по расцветке и размеру;
 *   2. два паспорта одного размера дают ОДНУ строку — паспорт основание, а не строка;
 *   3. пока открыта коробка, документ ФОРМИРУЕТСЯ и честно говорит, чего ждёт;
 *   4. когда фактов больше нет — становится СФОРМИРОВАН сам, без чьей-либо кнопки;
 *   5. поздний факт после фиксации документ ПЕРЕСОБИРАЕТ и помечает причину;
 *   6. повторное закрытие второй документ не заводит (гонка авто- и ручного закрытия);
 *   7. кнопки «провести» нет: API документа — только чтение.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';

describeWithDb('integration — документ выпуска собирается сам', () => {
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

  /** Заказ на 10 шт с двумя упакованными паспортами одного размера. Не закрывает. */
  async function orderReadyToClose(): Promise<string> {
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
    return orderId;
  }

  async function close(orderId: string): Promise<void> {
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
  }

  async function documentOf(orderId: string) {
    const res = await request(t.app.getHttpServer())
      .get(`/api/admin/orders/${orderId}/production-document`)
      .set('Cookie', cookies.manager)
      .expect(200);
    return res.body;
  }

  test('рождается вместе с закрытием заказа: номер, строки, состав', async () => {
    const orderId = await orderReadyToClose();
    // До закрытия документа нет: выпуск ещё не состоялся.
    expect(await documentOf(orderId)).toEqual({});

    await close(orderId);
    const doc = await documentOf(orderId);
    expect(doc.number).toMatch(/^ПР-\d{8}-\d{4}$/);
    expect(doc.orderId).toBe(orderId);
    expect(doc.qtyGood).toBe(10);
    expect(doc.qtyPlan).toBe(10);
    // Два паспорта одного размера — ОДНА строка, оба номера как основание.
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0].qtyGood).toBe(10);
    expect(doc.lines[0].sizeCode).toBe('M');
    expect(doc.lines[0].passportNumbers).toHaveLength(2);
  });

  test('пока открыта коробка — формируется и говорит, чего ждёт', async () => {
    const orderId = await orderReadyToClose();
    const passport = await t.prisma.passport.findFirst({ where: { orderId } });
    // Незакрытая коробка = сдельная по ней ещё не подтверждена: документ обязан ждать.
    const box = await t.prisma.box.create({
      data: {
        number: `B-PD-${Date.now()}`,
        qrCode: `QR-B-PD-${Date.now()}`,
        totalQty: 4,
        createdById: seed.employees['shop-chief'].id,
      },
    });
    await t.prisma.boxItem.create({
      data: { boxId: box.id, passportId: passport!.id, qty: passport!.qtyGood ?? 0 },
    });

    await close(orderId);
    const doc = await documentOf(orderId);
    expect(doc.status).toBe('FORMING');
    expect(doc.readyAt).toBeNull();
    expect(doc.pendingReasons.map((r: { code: string }) => r.code)).toContain('OPEN_BOX');
    expect(doc.pendingReasons[0].detail).toContain(box.number);
  });

  test('фактов больше нет — становится сформированным сам, без кнопки', async () => {
    const orderId = await orderReadyToClose();
    await close(orderId);
    const doc = await documentOf(orderId);
    expect(doc.status).toBe('READY');
    expect(doc.readyAt).toBeTruthy();
    expect(doc.pendingReasons).toEqual([]);
  });

  test('неподтверждённая сдельная держит документ и видна отдельно от суммы', async () => {
    const orderId = await orderReadyToClose();
    const passports = await t.prisma.passport.findMany({ where: { orderId } });
    const operationId = Object.values(seed.operations)[0].id;
    await t.prisma.operationEntry.create({
      data: {
        passportId: passports[0].id,
        operationId,
        employeeId: seed.employees.cutter.id,
        qty: 4,
        ratePerUnit: '10',
        amount: '40',
        status: 'PENDING_RELEASE',
      },
    });

    await close(orderId);
    const doc = await documentOf(orderId);
    expect(doc.status).toBe('FORMING');
    expect(doc.pendingReasons.map((r: { code: string }) => r.code)).toContain(
      'PENDING_EARNINGS',
    );
    // Обещание — не трата: в сумму не входит, но видно.
    expect(doc.cost.pieceworkPendingRub).toBe(40);
    expect(doc.cost.pieceworkRub).toBe(0);
    expect(doc.cost.totalRub).toBe(0);
  });

  test('поздний факт после фиксации документ пересобирает и помечает причину', async () => {
    const orderId = await orderReadyToClose();
    await close(orderId);
    expect((await documentOf(orderId)).status).toBe('READY');

    // Списание материала пришло задним числом — учёт обязан сойтись с цехом.
    await t.prisma.materialIssue.create({
      data: {
        orderId,
        status: 'POSTED',
        totalCost: '5000',
        postedAt: new Date(),
        lines: {
          create: [
            {
              description: 'Кулирка чёрная',
              unit: 'кг',
              issuedQty: '10',
              unitCost: '500',
              totalCost: '5000',
            },
          ],
        },
      },
    });

    const doc = await documentOf(orderId);
    expect(doc.cost.materialsOwnRub).toBe(5000);
    expect(doc.cost.totalRub).toBe(5000);
    expect(doc.recalculatedAt).toBeTruthy();
    expect(doc.recalcReason).toBeTruthy();
    expect(doc.status).toBe('READY');
  });

  test('повторное закрытие второй документ не заводит', async () => {
    const orderId = await orderReadyToClose();
    await close(orderId);
    // Второе закрытие отбивается статусом заказа — документ обязан остаться один.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(409);
    expect(await t.prisma.productionDocument.count({ where: { orderId } })).toBe(1);
  });

  test('достройка: заказ, закрытый до появления раздела, получает документ кнопкой', async () => {
    const orderId = await orderReadyToClose();
    // Имитируем «старый» закрытый заказ: статус и дата закрытия есть, документа нет —
    // ровно то состояние, в котором заказы застали появление раздела.
    await t.prisma.order.update({
      where: { id: orderId },
      data: { status: 'DONE', completedAt: new Date('2026-08-20T10:00:00.000Z') },
    });
    expect(await t.prisma.productionDocument.count({ where: { orderId } })).toBe(0);

    const built = await request(t.app.getHttpServer())
      .post(`/api/admin/orders/${orderId}/production-document`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    expect(built.body.qtyGood).toBe(10);
    expect(built.body.lines).toHaveLength(1);
    // Номер несёт дату ЗАКРЫТИЯ заказа, а не сегодняшнюю: порядок номеров обязан совпадать
    // с порядком выпуска.
    expect(built.body.number).toMatch(/^ПР-20260820-\d{4}$/);
    // И честно помечен как достроенный: строка появилась позже события.
    expect(built.body.backfilledAt).toBeTruthy();

    // Идемпотентно: повтор второй документ не заводит.
    await request(t.app.getHttpServer())
      .post(`/api/admin/orders/${orderId}/production-document`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    expect(await t.prisma.productionDocument.count({ where: { orderId } })).toBe(1);
  });

  test('достройка отказывает по незакрытому заказу и по заказу без упаковки', async () => {
    const inWork = await orderReadyToClose();
    // Заказ ещё в производстве — выпуска не было.
    await request(t.app.getHttpServer())
      .post(`/api/admin/orders/${inWork}/production-document`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(409);

    // Закрыт, но паспорта не упакованы: пустой документ выпуска — не документ.
    await t.prisma.passport.updateMany({
      where: { orderId: inWork },
      data: { status: 'IN_PROGRESS' },
    });
    await t.prisma.order.update({
      where: { id: inWork },
      data: { status: 'DONE', completedAt: new Date('2026-08-21T10:00:00.000Z') },
    });
    const res = await request(t.app.getHttpServer())
      .post(`/api/admin/orders/${inWork}/production-document`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(409);
    expect(res.body.code).toBe('PRODUCTION_DOCUMENT_NOTHING_RELEASED');
    expect(await t.prisma.productionDocument.count({ where: { orderId: inWork } })).toBe(0);
  });

  test('список отдаёт документ и счётчик формирующихся, а писать в раздел нечем', async () => {
    const orderId = await orderReadyToClose();
    await close(orderId);
    const list = await request(t.app.getHttpServer())
      .get('/api/admin/production-documents')
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].orderNumber).toBeTruthy();
    expect(list.body.formingCount).toBe(0);

    const one = await request(t.app.getHttpServer())
      .get(`/api/admin/production-documents/${list.body.items[0].id}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(one.body.lines).toHaveLength(1);

    // ⛔ Документ никто не проводит: ручек записи в разделе нет вовсе.
    await request(t.app.getHttpServer())
      .post(`/api/admin/production-documents/${list.body.items[0].id}/post`)
      .set('Cookie', cookies.manager)
      .expect(404);
  });
});
