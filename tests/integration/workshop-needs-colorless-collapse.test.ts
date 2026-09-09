/**
 * Integration-тесты правила «материал БЕЗ ЦВЕТА — одна позиция на весь
 * заказ» (см. `WorkshopNeedsService.calculateForOrder`).
 *
 * Засада, ради которой правило появилось. Потребность считается ПО
 * РАСЦВЕТКАМ: своя техкарта × поразмерный план цвета. Материал, у которого
 * цвета нет вовсе (дублерин, нитки, бирка), выходил из этого цикла по одной
 * строке на расцветку — N одинаковых позиций, которые в списке потребности
 * и в закупке ничем друг от друга не отличаются (расцветку таблица
 * потребности не показывает). Закупщик покупает дублерин ОДИН раз на заказ.
 *
 * Сторожим три вещи:
 *   1. материал без цвета даёт ОДНУ order-level строку с суммой по всем
 *      расцветкам, а материал С цветом остаётся по расцветкам;
 *   2. схлопывание не трогает заказ с одной расцветкой (числа как раньше);
 *   3. пересчёт переносит на схлопнутую строку закупочный блок, введённый
 *      ещё по строкам расцветок, — иначе первый же пересчёт после выката
 *      стёр бы цену у каждого такого материала.
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
import { copySpecLinesTo, createSpecPattern } from '../utils/spec';

interface NeedRow {
  id: string;
  sourceName: string | null;
  description: string;
  calculatedQty: string;
  unit: string;
  orderVariantId: string | null;
  variantColor: string | null;
  calculationNote: string | null;
}

describeWithDb('integration — потребность: материал без цвета', () => {
  let t: TestApp;
  let seed: SeedResult;
  let patternItemId: string;

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

    // Лекало БЕЗ категории и параметров — legacy-путь расчёта: каждая
    // строка спецификации даёт свою потребность. Так сценарий проверяет
    // именно схлопывание, а не выбор источника количества.
    const pattern = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', t.adminCookie)
      .send({ name: 'Футболка без цвета', article: 'P-COLORLESS' })
      .expect(201);
    patternItemId = pattern.body.id as string;

    const spec = await createSpecPattern(t, t.adminCookie, {
      name: 'Спека дублерина',
      materialLines: [
        // Цветное полотно — остаётся по расцветкам.
        {
          name: 'Кулирка',
          unit: 'м пог.',
          qtyPerUnit: '1',
          materialRole: 'MAIN_FABRIC',
          fabricType: 'Кулирка',
          colorRule: 'ORDER_COLOR',
        },
        // Дублерин без цвета — один на весь заказ.
        {
          name: 'Дублерин',
          unit: 'м пог.',
          qtyPerUnit: '0.5',
          materialRole: 'LINING',
          fabricType: 'Дублерин',
          colorRule: 'NO_COLOR',
        },
      ],
    });
    await copySpecLinesTo(t, spec.id, patternItemId);
  });

  /** Заказ с двумя расцветками (Белый 60 / Чёрный 40 по размеру M). */
  async function createOrderWithTwoColorways(): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-09-09T00:00:00.000Z',
        productId: seed.product.id,
        clientId: seed.client.id,
        patternItemId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        variants: [
          { color: 'Белый', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 60 }] },
          { color: 'Чёрный', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }] },
        ],
      })
      .expect(201);
    return res.body.id as string;
  }

  async function calculate(orderId: string, force = false): Promise<NeedRow[]> {
    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send(force ? { force: true } : {})
      .expect(201);
    return res.body.needs as NeedRow[];
  }

  const byName = (needs: NeedRow[], name: string): NeedRow[] =>
    needs.filter((n) => (n.sourceName ?? n.description).includes(name));

  test('дублерин без цвета — одна строка на заказ, кулирка — по расцветкам', async () => {
    const orderId = await createOrderWithTwoColorways();
    const needs = await calculate(orderId);

    // Цветное полотно живёт по расцветкам: 60 + 40.
    const fabric = byName(needs, 'Кулирка');
    expect(fabric).toHaveLength(2);
    expect(fabric.every((n) => n.orderVariantId != null)).toBe(true);
    expect(fabric.map((n) => n.variantColor).sort()).toEqual([
      'Белый',
      'Чёрный',
    ]);
    expect(
      fabric.reduce((s, n) => s + Number(n.calculatedQty), 0),
    ).toBeCloseTo(100, 4);

    // Дублерин — ОДНА позиция на весь заказ: 0.5 × (60 + 40) = 50.
    const lining = byName(needs, 'Дублерин');
    expect(lining).toHaveLength(1);
    expect(lining[0].orderVariantId).toBeNull();
    expect(lining[0].variantColor).toBeNull();
    expect(Number(lining[0].calculatedQty)).toBeCloseTo(50, 4);
    // Заметка объясняет закупщику, почему позиция одна.
    expect(lining[0].calculationNote ?? '').toMatch(
      /одна позиция на весь заказ/,
    );

    // И в БД тоже одна — схлопывание идёт в расчёте, а не в отображении.
    const rows = await t.prisma.workshopNeed.findMany({
      where: { orderId, materialRole: 'LINING' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].orderVariantId).toBeNull();
  });

  test('заказ с одной расцветкой считается как раньше', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-09-09T00:00:00.000Z',
        productId: seed.product.id,
        clientId: seed.client.id,
        patternItemId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        color: 'Белый',
      })
      .expect(201);
    const needs = await calculate(res.body.id as string);

    const lining = byName(needs, 'Дублерин');
    expect(lining).toHaveLength(1);
    expect(Number(lining[0].calculatedQty)).toBeCloseTo(50, 4);
    // Заметки о схлопывании нет: схлопывать было нечего.
    expect(lining[0].calculationNote ?? '').not.toMatch(
      /одна позиция на весь заказ/,
    );
  });

  test('цена, введённая по строкам расцветок, переезжает на схлопнутую строку', async () => {
    const orderId = await createOrderWithTwoColorways();
    const needs = await calculate(orderId);
    const lining = byName(needs, 'Дублерин')[0];

    // Воспроизводим состояние ДО этой правки: две строки дублерина по
    // расцветкам, цена закупщика — на первой. Именно так выглядят уже
    // посчитанные заказы в момент выката.
    const row = await t.prisma.workshopNeed.findUniqueOrThrow({
      where: { id: lining.id },
    });
    const specRows = await t.prisma.orderMaterialRequirement.findMany({
      where: { orderId, materialRole: 'LINING' },
      include: { orderVariant: true },
      orderBy: { orderVariant: { ordinal: 'asc' } },
    });
    expect(specRows).toHaveLength(2);
    const { id: _id, createdAt: _c, updatedAt: _u, ...base } = row;
    await t.prisma.workshopNeed.delete({ where: { id: row.id } });
    for (const [i, spec] of specRows.entries()) {
      await t.prisma.workshopNeed.create({
        data: {
          ...base,
          sourceId: spec.id,
          orderVariantId: spec.orderVariantId,
          variantColor: spec.variantColor,
          calculatedQty: spec.totalQty,
          // Закупочный блок ввели только по первой расцветке — цена у
          // материала одна, вводить её дважды закупщик не станет.
          ...(i === 0
            ? {
                quotedPrice: '120.50',
                quotedCurrency: 'RUB',
                purchaseQty: '55',
                supplierNameText: 'ООО Прокладка',
              }
            : {}),
        },
      });
    }

    const after = await calculate(orderId);
    const collapsed = byName(after, 'Дублерин');
    expect(collapsed).toHaveLength(1);

    const saved = await t.prisma.workshopNeed.findUniqueOrThrow({
      where: { id: collapsed[0].id },
    });
    expect(saved.orderVariantId).toBeNull();
    expect(Number(saved.calculatedQty)).toBeCloseTo(50, 4);
    expect(Number(saved.quotedPrice)).toBeCloseTo(120.5, 2);
    expect(saved.quotedCurrency).toBe('RUB');
    expect(Number(saved.purchaseQty)).toBeCloseTo(55, 4);
    expect(saved.supplierNameText).toBe('ООО Прокладка');
  });
});
