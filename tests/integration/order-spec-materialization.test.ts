/**
 * Integration-тесты этапа 3 плана «техкарты → номенклатура»: снапшот
 * материалов заказа материализуется из СПЕЦИФИКАЦИИ КАРТОЧКИ НОМЕНКЛАТУРЫ
 * (`PatternItemMaterialLine` / `PatternItemSpecParameter`), техкарта —
 * legacy-фолбэк.
 *
 * Проверяем ключевые гарантии перехода:
 *   1. Заказ БЕЗ техкарты, но с лекалом со спецификацией: гейт
 *      `ORDER_TECH_CARD_REQUIRED` пропускает, снапшот материализуется из
 *      спецификации (`sourcePatternLineId`/`sourcePatternItemId`), слоты
 *      материализуются в `OrderTechCardParameter` (`sourcePatternItemId`,
 *      не ad-hoc).
 *   2. Заказ с техкартой И спецификацией: для НОВОГО заказа выигрывает
 *      спецификация.
 *   3. Гарантия выката: живой заказ, материализованный из техкарты, НЕ
 *      перечитывается из появившейся спецификации при обычном пересчёте —
 *      только пересчёт количеств; явное «Обновить из шаблона» переключает
 *      источник на спецификацию.
 *   4. Расцветки: одна спецификация материализуется в каждую расцветку
 *      (решение §1 анализа), слоты — на каждой расцветке.
 *   5. Заказ без единого источника (нет ни техкарты, ни спецификации) —
 *      гейт по-прежнему 409.
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

describeWithDb('integration — order snapshot from pattern spec', () => {
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
  async function createPattern(): Promise<string> {
    counter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', t.adminCookie)
      .send({ name: 'Худи спец-заказ', article: `OSM-${counter}` })
      .expect(201);
    return r.body.id as string;
  }

  async function fillSpec(patternId: string): Promise<void> {
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/material-spec`)
      .set('Cookie', t.adminCookie)
      .send({
        materialLines: [
          {
            name: 'Кулирка',
            unit: 'кг',
            normUnit: 'м пог.',
            qtyPerUnit: '1.2',
            materialRole: 'MAIN_FABRIC',
            fabricType: 'кулирка',
            densityGsm: 160,
            plannedWidthCm: 180,
            colorRule: 'ORDER_COLOR',
            parameterBindings: { 'char:density': 'main_density' },
          },
          {
            name: 'Молния',
            unit: 'шт',
            qtyPerUnit: '1',
            materialRole: 'PACKAGING',
            fabricType: 'Молния',
            colorRule: 'ORDER_SELECTED_COLOR',
          },
        ],
        parameters: [
          {
            key: 'main_density',
            label: 'Плотность полотна',
            inputType: 'NUMBER',
            unit: 'г/м²',
            isRequired: true,
            defaultValue: '160',
          },
        ],
      })
      .expect(200);
  }

  async function createTechCard(): Promise<string> {
    counter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', t.adminCookie)
      .send({
        code: `TC-OSM-${counter}`,
        name: 'Легаси техкарта',
        materialLines: [
          { name: 'Футер легаси', unit: 'кг', qtyPerUnit: '2' },
        ],
      })
      .expect(201);
    return r.body.id as string;
  }

  async function createOrder(opts: {
    patternItemId?: string;
    techCardId?: string;
    variants?: Array<{ color: string; qty: number }>;
    qty?: number;
  }): Promise<string> {
    const qty = opts.qty ?? 100;
    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-08-11T00:00:00.000Z',
        clientId: seed.client.id,
        patternItemId: opts.patternItemId,
        techCardId: opts.techCardId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: qty }],
        variants: (opts.variants ?? []).map((v) => ({
          color: v.color,
          sizes: [{ sizeId: seed.sizes.M, qtyPlan: v.qty }],
        })),
      })
      .expect(201);
    return r.body.id as string;
  }

  function startCalc(orderId: string) {
    return request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', t.adminCookie);
  }

  test('заказ без техкарты: гейт пропускает, снапшот — из спецификации', async () => {
    const patternId = await createPattern();
    await fillSpec(patternId);
    const orderId = await createOrder({ patternItemId: patternId });

    await startCalc(orderId).expect(201);

    const rows = await t.prisma.orderMaterialRequirement.findMany({
      where: { orderId },
      orderBy: { sortOrder: 'asc' },
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.sourcePatternItemId).toBe(patternId);
      expect(r.sourcePatternLineId).not.toBeNull();
      expect(r.sourceTechCardId).toBeNull();
      expect(r.sourceTechCardLineId).toBeNull();
    }
    const fabric = rows.find((r) => r.name === 'Кулирка')!;
    // Норма и расщепление единиц едут из строки спецификации.
    expect(fabric.normUnit).toBe('м пог.');
    expect(fabric.unit).toBe('кг');
    // Слот «плотность» материализован из спецификации: не ad-hoc, со
    // значением по умолчанию.
    const params = await t.prisma.orderTechCardParameter.findMany({
      where: { orderId },
    });
    expect(params).toHaveLength(1);
    expect(params[0].key).toBe('main_density');
    expect(params[0].sourcePatternItemId).toBe(patternId);
    expect(params[0].sourceTechCardId).toBeNull();
    expect(params[0].value).toBe('160');
  });

  test('техкарта + спецификация: у нового заказа выигрывает спецификация', async () => {
    const patternId = await createPattern();
    await fillSpec(patternId);
    const techCardId = await createTechCard();
    const orderId = await createOrder({
      patternItemId: patternId,
      techCardId,
    });
    await startCalc(orderId).expect(201);

    const rows = await t.prisma.orderMaterialRequirement.findMany({
      where: { orderId },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.sourcePatternItemId === patternId)).toBe(true);
    expect(rows.some((r) => r.name === 'Футер легаси')).toBe(false);
  });

  test('гарантия выката: живой заказ на техкарте не перечитывается сам; «Обновить из шаблона» переключает на спецификацию', async () => {
    const patternId = await createPattern();
    const techCardId = await createTechCard();
    // Спецификации ещё нет → заказ материализуется из техкарты (фолбэк).
    // Снапшот строится уже при создании (DRAFT) — статус не меняем, чтобы
    // правка позиций ниже оставалась разрешённой.
    const orderId = await createOrder({
      patternItemId: patternId,
      techCardId,
    });
    let rows = await t.prisma.orderMaterialRequirement.findMany({
      where: { orderId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceTechCardId).toBe(techCardId);
    expect(rows[0].name).toBe('Футер легаси');

    // Спецификация появилась ПОСЛЕ материализации.
    await fillSpec(patternId);

    // Обычный пересчёт (правка тиража) НЕ перечитывает источник: состав
    // остаётся из техкарты, но количество пересчитано.
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', t.adminCookie)
      .send({ items: [{ sizeId: seed.sizes.M, qtyPlan: 150 }] })
      .expect(200);
    rows = await t.prisma.orderMaterialRequirement.findMany({
      where: { orderId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceTechCardId).toBe(techCardId);
    expect(rows[0].sourcePatternItemId).toBeNull();
    expect(Number(rows[0].totalQty)).toBe(300); // 2 × 150

    // Явное «Обновить из шаблона» — источник переключается на спецификацию.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/reload-from-template`)
      .set('Cookie', t.adminCookie)
      .expect(201);
    rows = await t.prisma.orderMaterialRequirement.findMany({
      where: { orderId },
      orderBy: { sortOrder: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sourcePatternItemId === patternId)).toBe(true);
    expect(rows.some((r) => r.name === 'Кулирка')).toBe(true);
  });

  test('расцветки: одна спецификация — снапшот и слоты в каждой расцветке', async () => {
    const patternId = await createPattern();
    await fillSpec(patternId);
    const orderId = await createOrder({
      patternItemId: patternId,
      variants: [
        { color: 'Белый', qty: 60 },
        { color: 'Чёрный', qty: 40 },
      ],
    });
    await startCalc(orderId).expect(201);

    const variants = await t.prisma.orderVariant.findMany({
      where: { orderId },
      orderBy: { ordinal: 'asc' },
    });
    expect(variants).toHaveLength(2);
    for (const v of variants) {
      const rows = await t.prisma.orderMaterialRequirement.findMany({
        where: { orderId, orderVariantId: v.id },
      });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.sourcePatternItemId === patternId)).toBe(
        true,
      );
      // Правило цвета решается цветом расцветки — одна спецификация даёт
      // разные итоговые цвета (решение §1 анализа).
      const fabric = rows.find((r) => r.name === 'Кулирка')!;
      expect(fabric.resolvedColorText).toBe(v.color);
      const params = await t.prisma.orderTechCardParameter.findMany({
        where: { orderId, orderVariantId: v.id },
      });
      expect(params).toHaveLength(1);
      expect(params[0].sourcePatternItemId).toBe(patternId);
    }
  });

  test('без техкарты и без спецификации гейт по-прежнему 409', async () => {
    const patternId = await createPattern();
    const orderId = await createOrder({ patternItemId: patternId });
    const r = await startCalc(orderId).expect(400);
    expect(r.body.code).toBe('ORDER_TECH_CARD_REQUIRED');
  });
});
