/**
 * Integration-тест: состав заказа набран РУКАМИ, а у карточки номенклатуры
 * спецификации материалов нет вовсе.
 *
 * Регрессия по проду (заказ 02-00024, 23.08.2026). У карточки «Бомбер basic»
 * ноль строк `PatternItemMaterialLine` — нормы и погонные метры есть, а состав
 * менеджер заводит прямо в заказе. Ручная строка создаётся с `totalQty = 0` в
 * расчёте на ближайшую пересборку снимка, но пересборка пересчитывала тираж
 * ТОЛЬКО у групп, которые материализуются из спецификации. Спецификации нет —
 * пересчёт не наступал НИКОГДА: в заказе весь расход стоял нулями, потребность
 * цеха повторяла нули, и материалы уходили в закупку по нулю.
 *
 * Проверяем обе стороны цепочки: тираж в снимке заказа и число в потребности,
 * в том числе после правки количества.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — ручной состав заказа без спецификации лекала', () => {
  let t: TestApp;
  let seed: SeedResult;

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
  });

  let counter = 0;

  /** Карточка номенклатуры БЕЗ спецификации материалов — как «Бомбер basic». */
  async function createPatternWithoutSpec(): Promise<string> {
    counter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', t.adminCookie)
      .send({ name: 'Бомбер без спецификации', article: `MSP-${counter}` })
      .expect(201);
    return r.body.id as string;
  }

  async function createOrder(patternItemId: string, qty: number): Promise<string> {
    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-08-24T00:00:00.000Z',
        clientId: seed.client.id,
        patternItemId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: qty }],
      })
      .expect(201);
    return r.body.id as string;
  }

  async function addManualLines(orderId: string): Promise<void> {
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/lines/bulk`)
      .set('Cookie', t.adminCookie)
      .send({
        orderVariantId: null,
        lines: [
          { name: 'Нитки', unit: 'м', qtyPerUnit: '80' },
          { name: 'Молния для основы', unit: 'шт', qtyPerUnit: '1' },
        ],
      })
      .expect(201);
  }

  async function totalsByName(orderId: string): Promise<Record<string, number>> {
    const rows = await t.prisma.orderMaterialRequirement.findMany({
      where: { orderId },
      select: { name: true, totalQty: true },
    });
    return Object.fromEntries(rows.map((r) => [r.name, Number(r.totalQty)]));
  }

  test('ручная строка получает тираж, потребность считается не по нулю', async () => {
    const patternId = await createPatternWithoutSpec();
    const orderId = await createOrder(patternId, 100);
    await addManualLines(orderId);

    // Снимок заказа: расход = норма × тираж, а не ноль «до ближайшего resync».
    expect(await totalsByName(orderId)).toEqual({
      Нитки: 8000,
      'Молния для основы': 100,
    });

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', t.adminCookie)
      .expect(201);

    const needs = await t.prisma.workshopNeed.findMany({
      where: { orderId },
      select: { sourceName: true, calculatedQty: true, unit: true },
    });
    const byName = Object.fromEntries(
      needs.map((n) => [n.sourceName, Number(n.calculatedQty)]),
    );
    expect(byName).toEqual({ Нитки: 8000, 'Молния для основы': 100 });
  });

  test('правка тиража пересчитывает ручные строки', async () => {
    const patternId = await createPatternWithoutSpec();
    const orderId = await createOrder(patternId, 100);
    await addManualLines(orderId);

    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', t.adminCookie)
      .send({ items: [{ sizeId: seed.sizes.M, qtyPlan: 200 }] })
      .expect(200);

    expect(await totalsByName(orderId)).toEqual({
      Нитки: 16000,
      'Молния для основы': 200,
    });
  });
});
