/**
 * Обратный шов §0.5: очередь выпуска готовой продукции для ERP и приём её ответа.
 *
 * «Выпуск готовой продукции швейного цеха приходуется на склад ERP. Собственных складов —
 * материалов, готовой продукции, полок — у цеха нет» (правило владельца §0.5,
 * `service/docs/kb/sewing.md`). Отсюда проверки:
 *
 *   1. без даты отсечки очередь ПУСТА — иначе первый же опрос отдал бы весь архив упаковки;
 *   2. паспорта отменённых заказов в очередь не попадают;
 *   3. упакованный паспорт отдаётся с ключами сопоставления (лекало, размер, цвет);
 *   4. ответ ERP ложится зеркалом на паспорт, а повторный ответ его заменяет;
 *   5. плохой элемент ответа не роняет весь пакет;
 *   6. при поднятом флаге «остаток ГП ведёт ERP» ручные движения в цехе отвечают 409.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';
import { ErpFinishedGoodsService } from '../../apps/api/src/modules/integrations/erp-finished-goods.service.js';

describeWithDb('integration — выпуск готовой продукции цеха уходит в ERP (§0.5)', () => {
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

  /** Заказ с лекалом и упакованный паспорт на 4 шт. */
  async function packedPassport(): Promise<{ orderId: string; passportId: string }> {
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
    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-FG-1',
        cutDate: '2026-09-01T00:00:00.000Z',
        qtyCut: 4,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passport.body.id;
    await t.prisma.passport.update({
      where: { id: passportId },
      data: { status: 'PACKED', qtyGood: 4 },
    });
    await t.prisma.passportEvent.create({
      data: { passportId, type: 'PACKED', qty: 4 },
    });
    return { orderId, passportId };
  }

  async function setSince(value: Date | null): Promise<void> {
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', singleton: true, erpFinishedGoodsSince: value },
      update: { erpFinishedGoodsSince: value },
    });
  }

  test('без даты отсечки очередь пуста — архив упаковки не уезжает в ERP', async () => {
    await packedPassport();
    await setSince(null);
    const queue = await new ErpFinishedGoodsService(t.prisma).listPending(10);
    expect(queue.count).toBe(0);
  });

  test('упакованный паспорт отдаётся с ключами сопоставления', async () => {
    const { passportId, orderId } = await packedPassport();
    await setSince(new Date('2026-08-01T00:00:00.000Z'));
    const queue = await new ErpFinishedGoodsService(t.prisma).listPending(10);
    expect(queue.count).toBe(1);
    const item = queue.items[0] as Record<string, any>;
    expect(item.passport_id).toBe(passportId);
    expect(item.order_id).toBe(orderId);
    expect(item.qty_good).toBe(4);
    expect(item.size_code).toBe('M');
    expect(item.color).toBeTruthy();
    // Лекало — единственный стабильный ключ: техническая карточка изделия заводится под заказ.
    expect(item.pattern_item_id).toBeTruthy();
  });

  test('паспорта отменённого заказа в очередь не попадают', async () => {
    const { orderId } = await packedPassport();
    await setSince(new Date('2026-08-01T00:00:00.000Z'));
    await t.prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
    const queue = await new ErpFinishedGoodsService(t.prisma).listPending(10);
    expect(queue.count).toBe(0);
  });

  test('ответ ERP ложится зеркалом и выводит паспорт из очереди', async () => {
    const { passportId } = await packedPassport();
    await setSince(new Date('2026-08-01T00:00:00.000Z'));
    const svc = new ErpFinishedGoodsService(t.prisma);
    const res = await svc.ack([
      {
        passport_id: passportId,
        state: 'POSTED',
        erp_document_number: 'ШВЦ-000001',
        erp_warehouse_name: 'СГПМП',
        erp_nomenclature_name: 'Худи Oversize',
        qty: 4,
        posted_at: '2026-09-03T10:00:00.000Z',
      },
    ]);
    expect(res.accepted).toBe(1);
    expect(res.skipped).toHaveLength(0);
    const mirror = await t.prisma.erpFinishedGoodsReceipt.findUniqueOrThrow({
      where: { passportId },
    });
    expect(mirror.state).toBe('POSTED');
    expect(mirror.erpDocumentNumber).toBe('ШВЦ-000001');
    expect(mirror.qty).toBe(4);
    expect((await svc.listPending(10)).count).toBe(0);
    // Сторно от ERP заменяет ответ целиком, а не кладёт второй.
    await svc.ack([{ passport_id: passportId, state: 'REVERSED' }]);
    const after = await t.prisma.erpFinishedGoodsReceipt.findUniqueOrThrow({ where: { passportId } });
    expect(after.state).toBe('REVERSED');
    expect(await t.prisma.erpFinishedGoodsReceipt.count()).toBe(1);
  });

  test('плохой элемент ответа не роняет пакет', async () => {
    const { passportId } = await packedPassport();
    const svc = new ErpFinishedGoodsService(t.prisma);
    const res = await svc.ack([
      { passport_id: 'нет-такого', state: 'POSTED' },
      { passport_id: passportId, state: 'СТРАННОЕ' },
      { passport_id: passportId, state: 'FAILED', error: 'Изделие не сопоставлено' },
    ]);
    expect(res.accepted).toBe(1);
    expect(res.skipped.map((s) => s.reason).sort()).toEqual(['passport_not_found', 'unknown_state']);
    const mirror = await t.prisma.erpFinishedGoodsReceipt.findUniqueOrThrow({ where: { passportId } });
    expect(mirror.state).toBe('FAILED');
    expect(mirror.error).toBe('Изделие не сопоставлено');
  });

  test('при поднятом флаге ручные движения ГП в цехе закрыты', async () => {
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', singleton: true, erpOwnsFinishedGoods: true },
      update: { erpOwnsFinishedGoods: true },
    });
    // Тело валидное: отказ обязан быть именно «остаток ведёт ERP», а не ошибкой формы —
    // иначе человек чинил бы не то.
    const res = await request(t.app.getHttpServer())
      .post('/api/finished-goods/adjustments')
      .set('Cookie', cookies.manager)
      .send({
        finishedGoodsBalanceId: 'нет-такого-остатка',
        direction: 'IN',
        qty: 1,
        comment: 'проверка гарда',
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FINISHED_GOODS_OWNED_BY_ERP');
  });
});
