/**
 * Integration-тесты переноса закупочного блока через пересчёт потребности
 * (`buildPurchaseCarry` / `takePurchaseCarry` в
 * `WorkshopNeedsService.calculateForOrder`).
 *
 * Аудит движка расчёта 13.09.2026:
 *   - N2-4: «К закупке» переезжало на пересозданную строку без сверки с новой
 *     теорией. «Принять теорию» ставит `purchaseQty = calculatedQty` массово,
 *     и после смены нормы/тиража смета и `need_link.qty` ERP считались по
 *     СТАРОМУ числу молча (1 500 ₽ вместо 3 000). Правило: «К закупке»,
 *     равное прежнему расчёту, следует за новым; своё число закупщика
 *     переносится с предупреждением в `warnings` и `calculationNote`.
 *   - N2-7: `comment` и `expectedDeliveryDate` закупщика не входили в
 *     перенос и терялись при каждом пересчёте, включая автоматический по
 *     нетронутой строке.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';

interface NeedRow {
  id: string;
  status: string;
  calculatedQty: string;
  purchaseQty: string | null;
  quotedPrice: string | null;
  comment: string | null;
  expectedDeliveryDate: string | null;
  calculationNote: string | null;
  orderSampleId: string | null;
}

describeWithDb('integration — потребность: перенос закупочного блока', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookie: string;

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
  });

  const api = () => request(t.app.getHttpServer());

  /** 10 шт × 1,5 м/шт = 15 м; «Принять теорию» → purchaseQty 15, REVIEWED; цена 100 ₽. */
  async function prepareAccepted(): Promise<{ orderId: string; needId: string }> {
    const spec = await createSpecPattern(t, cookie, {
      name: 'carry spec',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
    });
    const order = await api()
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: '2026-09-13T00:00:00.000Z',
        clientId: seed.client.id,
        productId: seed.product.id,
        patternItemId: spec.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        variants: [{ color: 'Белый', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 10 }] }],
      })
      .expect(201);
    const orderId = order.body.id as string;
    await api().post(`/api/orders/${orderId}/start-calculation`).set('Cookie', cookie).send({}).expect(201);
    const needs = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    expect(needs).toHaveLength(1);
    expect(Number(needs[0]!.calculatedQty)).toBe(15);

    await api()
      .post(`/api/orders/${orderId}/workshop-needs/accept-calculated`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
    const accepted = await t.prisma.workshopNeed.findUniqueOrThrow({ where: { id: needs[0]!.id } });
    expect(accepted.status).toBe('REVIEWED');
    expect(Number(accepted.purchaseQty)).toBe(15);
    await api()
      .patch(`/api/workshop-needs/${accepted.id}`)
      .set('Cookie', cookie)
      .send({ quotedPrice: '100', quotedCurrency: 'RUB' })
      .expect(200);
    return { orderId, needId: accepted.id };
  }

  /** Норма в снимке заказа поправлена: 3 м/шт → 30 м (как правка строки спецификации в заказе). */
  async function changeNormTo3(orderId: string): Promise<void> {
    const upd = await t.prisma.orderMaterialRequirement.updateMany({
      where: { orderId },
      data: { qtyPerUnit: '3', totalQty: '30', qtySource: 'ORDER' },
    });
    expect(upd.count).toBe(1);
  }

  async function forceCalculate(orderId: string): Promise<{ row: NeedRow; warnings: string[] }> {
    const forced = await api()
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookie)
      .send({ force: true })
      .expect(201);
    const row = (forced.body.needs as NeedRow[]).find(
      (n) => n.status !== 'CANCELLED' && n.orderSampleId == null,
    )!;
    return { row, warnings: forced.body.warnings as string[] };
  }

  test('N2-4: «К закупке» = принятая теория → после смены нормы следует за новым расчётом', async () => {
    const { orderId, needId } = await prepareAccepted();
    await changeNormTo3(orderId);

    const { row, warnings } = await forceCalculate(orderId);
    expect(row.id).not.toBe(needId);
    expect(Number(row.calculatedQty)).toBe(30);
    // Закупщик принял теорию как есть (15 = 15) — новая теория 30 идёт и в «К закупке».
    expect(Number(row.purchaseQty)).toBe(30);
    expect(row.quotedPrice).toBe('100');
    expect(warnings.some((w) => /К закупке/u.test(w))).toBe(false);
    expect(row.calculationNote ?? '').not.toMatch(/К закупке/u);

    // Смета: 30 × 100 = 3 000, а не 1 500 по старому числу.
    const est = await api()
      .post(`/api/orders/${orderId}/complete-calculation`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
    expect(Number(est.body.totalCostRub)).toBe(3_000);
  });

  test('N2-4: своё число закупщика переносится, но расхождение с новой теорией названо в warnings и ноте', async () => {
    const { orderId, needId } = await prepareAccepted();
    // Закупщик поставил СВОЁ «К закупке» (20 ≠ 15 расчёта).
    await api()
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookie)
      .send({ purchaseQty: '20' })
      .expect(200);
    await changeNormTo3(orderId);

    const { row, warnings } = await forceCalculate(orderId);
    expect(Number(row.calculatedQty)).toBe(30);
    expect(Number(row.purchaseQty)).toBe(20);
    // Оба числа — «К закупке» и новый расчёт — видны и в ответе, и на строке.
    const warn = warnings.find((w) => /К закупке/u.test(w));
    expect(warn).toBeDefined();
    expect(warn).toMatch(/20 м/u);
    expect(warn).toMatch(/30 м/u);
    expect(warn).toMatch(/15 м/u);
    expect(row.calculationNote ?? '').toMatch(/К закупке/u);
    expect(row.calculationNote ?? '').toMatch(/30 м/u);
  });

  test('N2-4: своё число при НЕИЗМЕННОЙ теории переносится молча', async () => {
    const { orderId, needId } = await prepareAccepted();
    await api()
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookie)
      .send({ purchaseQty: '20' })
      .expect(200);

    const { row, warnings } = await forceCalculate(orderId);
    expect(Number(row.calculatedQty)).toBe(15);
    expect(Number(row.purchaseQty)).toBe(20);
    expect(warnings.some((w) => /К закупке/u.test(w))).toBe(false);
    expect(row.calculationNote ?? '').not.toMatch(/К закупке/u);
  });

  test('N2-7: комментарий и дата поставки закупщика переживают авто-пересчёт по нетронутой строке', async () => {
    const spec = await createSpecPattern(t, cookie, {
      name: 'carry comment spec',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
    });
    const order = await api()
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: '2026-09-13T00:00:00.000Z',
        clientId: seed.client.id,
        productId: seed.product.id,
        patternItemId: spec.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      })
      .expect(201);
    const orderId = order.body.id as string;
    const first = await api()
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
    const firstId = first.body.needs[0].id as string;

    // Только закупочные поля — строка остаётся CALCULATED и «нетронутой» для гейта.
    await api()
      .patch(`/api/workshop-needs/${firstId}`)
      .set('Cookie', cookie)
      .send({
        comment: 'https://sup.ru/item/123, договорились 450 ₽, самовывоз',
        expectedDeliveryDate: '2026-10-01T00:00:00.000Z',
        quotedPrice: '450',
        quotedCurrency: 'RUB',
      })
      .expect(200);

    const second = await api()
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
    const row = second.body.needs[0] as NeedRow;
    expect(row.id).not.toBe(firstId);
    expect(row.quotedPrice).toBe('450');
    expect(row.comment).toBe('https://sup.ru/item/123, договорились 450 ₽, самовывоз');
    expect(row.expectedDeliveryDate).toBe('2026-10-01T00:00:00.000Z');
  });
});
