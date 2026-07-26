/**
 * Integration-тесты этапа «Фурнитура и нормы» (см.
 * `apps/api/src/modules/patterns/patterns.service.ts::replaceParameterNorms`,
 * `apps/api/src/modules/workshop-needs/workshop-needs.service.ts::computeParameterNorm`,
 * `prisma/schema.prisma::PatternItemParameterNorm`).
 *
 * Acceptance ТЗ:
 *   1. Категория содержит MAIN_FABRIC AREA_M2_BY_SIZE + Люверсы /
 *      Шнур (PACKAGING QTY_PER_ITEM).
 *   2. Лекало с этой категорией.
 *   3. PUT /api/patterns/:id/parameter-norms сохраняет нормы.
 *   4. Создаём заказ qty = 100.
 *   5. POST /api/orders/:id/workshop-needs/calculate.
 *   6. WorkshopNeed создаются:
 *      - Люверсы = 200 шт (2 × 100), отдельная строка;
 *      - Шнур    = 100 шт (1 × 100), отдельная строка;
 *      - обе с materialRole = PACKAGING, разные sourceId.
 *
 * Защитные случаи:
 *   - попытка сохранить норму по AREA_M2_BY_SIZE параметру → 422
 *     PATTERN_PARAMETER_NORM_NOT_ALLOWED;
 *   - попытка сохранить норму по параметру другой категории → 422;
 *   - pattern без categoryId продолжает открываться (parameterNorms = []).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import {
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

interface CategoryWithParams {
  id: string;
  parameters: Array<{
    id: string;
    roleKey: string;
    label: string;
    inputType: string;
  }>;
}

describeWithDb('integration — pattern item parameter norms', () => {
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

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  let catCounter = 0;
  async function createCategoryWithHardware(
    nameSuffix?: string,
  ): Promise<CategoryWithParams> {
    // Категория «Худи»: MAIN_FABRIC AREA_M2_BY_SIZE + Люверсы / Шнур
    // (PACKAGING QTY_PER_ITEM). Один и тот же roleKey разрешён для
    // QTY_PER_ITEM (см. этап «Фурнитура: разрешить несколько параметров
    // категории с одним roleKey»). `nameSuffix` нужен, чтобы тесты,
    // которые создают две категории сразу, не упирались в уникальность
    // slug.
    catCounter += 1;
    const name = nameSuffix
      ? `Худи фурнитура ${nameSuffix}`
      : `Худи фурнитура ${catCounter}`;
    const r = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name,
        iconKey: 'HOODIE',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основной материал',
            inputType: 'AREA_M2_BY_SIZE',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Люверсы',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Шнур',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
        ],
      })
      .expect(201);
    return { id: r.body.id, parameters: r.body.parameters };
  }

  async function createPatternWithCategory(
    categoryId: string | null,
    article: string,
  ): Promise<string> {
    const r = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', t.adminCookie)
      .send({
        name: 'Худи фурнитура',
        article,
        categoryId: categoryId ?? undefined,
      })
      .expect(201);
    return r.body.id as string;
  }

  function findParam(
    cat: CategoryWithParams,
    label: string,
  ): { id: string; roleKey: string; inputType: string } {
    const p = cat.parameters.find((x) => x.label === label);
    if (!p) throw new Error(`Параметр "${label}" не найден в категории`);
    return p;
  }

  let tcCounter = 0;
  async function createTechCardSimple(): Promise<string> {
    tcCounter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', t.adminCookie)
      .send({
        // Код техкарты должен матчить ^[A-Z0-9][A-Z0-9_-]{0,47}$ —
        // см. `packages/shared/src/tech-cards.ts::TECH_CARD_CODE_PATTERN`.
        code: `TC-PN-${tcCounter}`,
        name: 'Tech card simple',
        materialLines: [
          { name: 'Нитки', unit: 'м', qtyPerUnit: '0.5' },
        ],
      })
      .expect(201);
    return r.body.id as string;
  }

  async function createOrder(opts: {
    techCardId: string;
    patternItemId: string;
    qtyPlan: number;
  }): Promise<string> {
    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        clientId: seed.client.id,
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: opts.qtyPlan }],
        techCardId: opts.techCardId,
        patternItemId: opts.patternItemId,
      })
      .expect(201);
    return r.body.id as string;
  }

  // -------------------------------------------------------------------------
  // 1. Сохранение норм + GET /patterns/:id отдаёт parameterNorms
  // -------------------------------------------------------------------------

  test('PUT /api/patterns/:id/parameter-norms сохраняет нормы и они приходят в GET', async () => {
    const cat = await createCategoryWithHardware();
    const lyversy = findParam(cat, 'Люверсы');
    const shnur = findParam(cat, 'Шнур');
    const patternId = await createPatternWithCategory(cat.id, 'P-NORM-OK');

    const put = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [
          { categoryParameterId: lyversy.id, qtyPerItem: '2' },
          {
            categoryParameterId: shnur.id,
            qtyPerItem: '1',
            comment: 'Чёрный шнур',
          },
        ],
      })
      .expect(200);
    expect(put.body.parameterNorms).toHaveLength(2);

    // GET возвращает то же самое + snapshot полей.
    const got = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    const norms = got.body.parameterNorms as Array<{
      id: string;
      categoryParameterId: string;
      roleKey: string;
      labelSnapshot: string;
      inputTypeSnapshot: string;
      qtyPerItem: string;
      unit: string;
      comment: string | null;
    }>;
    expect(norms).toHaveLength(2);
    const byLabel = new Map(norms.map((n) => [n.labelSnapshot, n]));
    expect(byLabel.get('Люверсы')?.qtyPerItem).toBe('2');
    expect(byLabel.get('Шнур')?.qtyPerItem).toBe('1');
    expect(byLabel.get('Шнур')?.comment).toBe('Чёрный шнур');
    // Snapshot полей: roleKey = PACKAGING, inputType = QTY_PER_ITEM,
    // unit = «шт» (из категории).
    for (const n of norms) {
      expect(n.roleKey).toBe('PACKAGING');
      expect(n.inputTypeSnapshot).toBe('QTY_PER_ITEM');
      expect(n.unit).toBe('шт');
    }
    // Аудит-событие.
    const audit = await t.prisma.auditLog.findFirst({
      where: {
        event: 'PATTERN_PARAMETER_NORMS_REPLACED',
        entityId: patternId,
      },
    });
    expect(audit).not.toBeNull();
  });

  test('повторный PUT перезаписывает нормы: пустой payload очищает', async () => {
    const cat = await createCategoryWithHardware();
    const lyversy = findParam(cat, 'Люверсы');
    const patternId = await createPatternWithCategory(cat.id, 'P-NORM-CLR');

    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [{ categoryParameterId: lyversy.id, qtyPerItem: '5' }],
      })
      .expect(200);

    const cleared = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({ norms: [] })
      .expect(200);
    expect(cleared.body.parameterNorms).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. Защитные случаи (422 PATTERN_PARAMETER_NORM_NOT_ALLOWED)
  // -------------------------------------------------------------------------

  test('AREA_M2_BY_SIZE параметр нельзя сохранить как норму (422)', async () => {
    const cat = await createCategoryWithHardware();
    const main = findParam(cat, 'Основной материал');
    const patternId = await createPatternWithCategory(cat.id, 'P-NORM-AREA');

    const r = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [{ categoryParameterId: main.id, qtyPerItem: '1' }],
      })
      .expect(422);
    expect(r.body.code).toBe('PATTERN_PARAMETER_NORM_NOT_ALLOWED');
  });

  test('параметр другой категории — 422', async () => {
    const cat = await createCategoryWithHardware();
    const other = await createCategoryWithHardware(); // другой instance
    // Найдём «Люверсы» из другой категории — тот же label, но
    // другой id и другая categoryId.
    const otherLyversy = findParam(other, 'Люверсы');
    const patternId = await createPatternWithCategory(cat.id, 'P-NORM-OTHER');

    const r = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [
          { categoryParameterId: otherLyversy.id, qtyPerItem: '2' },
        ],
      })
      .expect(422);
    expect(r.body.code).toBe('PATTERN_PARAMETER_NORM_NOT_ALLOWED');
  });

  test('лекало без categoryId — любой параметр отбивается 422', async () => {
    const cat = await createCategoryWithHardware();
    const lyversy = findParam(cat, 'Люверсы');
    const patternId = await createPatternWithCategory(null, 'P-NORM-NOCAT');

    // GET всё равно работает и parameterNorms = [].
    const got = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(got.body.categoryId).toBeNull();
    expect(got.body.parameterNorms).toEqual([]);

    // PUT с любым параметром — 422.
    const r = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [{ categoryParameterId: lyversy.id, qtyPerItem: '2' }],
      })
      .expect(422);
    expect(r.body.code).toBe('PATTERN_PARAMETER_NORM_NOT_ALLOWED');
  });

  test('qtyPerItem ≤ 0 отбивается Zod-ом', async () => {
    const cat = await createCategoryWithHardware();
    const lyversy = findParam(cat, 'Люверсы');
    const patternId = await createPatternWithCategory(cat.id, 'P-NORM-NEG');

    const r = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [{ categoryParameterId: lyversy.id, qtyPerItem: '0' }],
      });
    expect(r.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 3. WorkshopNeed: каждая норма → отдельная строка PATTERN_PARAMETER_NORM
  // -------------------------------------------------------------------------

  test('start-calculation создаёт WorkshopNeed по каждой норме (Люверсы / Шнур — отдельные строки)', async () => {
    const cat = await createCategoryWithHardware();
    const lyversy = findParam(cat, 'Люверсы');
    const shnur = findParam(cat, 'Шнур');
    const patternId = await createPatternWithCategory(cat.id, 'P-WN-NORMS');

    // Сохраняем нормы: Люверсы 2 шт, Шнур 1 шт.
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [
          { categoryParameterId: lyversy.id, qtyPerItem: '2' },
          { categoryParameterId: shnur.id, qtyPerItem: '1' },
        ],
      })
      .expect(200);

    const tcId = await createTechCardSimple();
    const orderId = await createOrder({
      techCardId: tcId,
      patternItemId: patternId,
      qtyPlan: 100,
    });

    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);

    const needs = calc.body.needs as Array<{
      sourceType: string | null;
      sourceId: string | null;
      sourceName: string | null;
      materialRole: string | null;
      calculatedQty: string;
      unit: string;
      description: string;
      calculationMethod: string;
      status: string;
    }>;

    // Должны быть три строки: 1 от ТЗ-техкарты (нитки) + 2 от норм.
    const normNeeds = needs.filter(
      (n) => n.sourceType === 'PATTERN_PARAMETER_NORM',
    );
    expect(normNeeds).toHaveLength(2);

    // Обе нормы — materialRole = PACKAGING, но разные sourceId,
    // отдельные строки, не объединены.
    expect(normNeeds.every((n) => n.materialRole === 'PACKAGING')).toBe(true);
    const sourceIds = normNeeds.map((n) => n.sourceId);
    expect(new Set(sourceIds).size).toBe(2);

    const byLabel = new Map(normNeeds.map((n) => [n.sourceName, n]));
    const ly = byLabel.get('Люверсы');
    const sh = byLabel.get('Шнур');
    expect(ly).toBeDefined();
    expect(sh).toBeDefined();

    // Люверсы: 2 × 100 = 200 шт.
    expect(Number(ly!.calculatedQty)).toBeCloseTo(200, 4);
    expect(ly!.unit).toBe('шт');
    expect(ly!.calculationMethod).toBe('QTY_PER_UNIT');
    expect(ly!.status).toBe('CALCULATED');

    // Шнур: 1 × 100 = 100 шт.
    expect(Number(sh!.calculatedQty)).toBeCloseTo(100, 4);
    expect(sh!.unit).toBe('шт');
  });

  test('лекало без норм фурнитуры — WorkshopNeed по нормам не создаются', async () => {
    const cat = await createCategoryWithHardware();
    const patternId = await createPatternWithCategory(cat.id, 'P-WN-NONORMS');
    const tcId = await createTechCardSimple();
    const orderId = await createOrder({
      techCardId: tcId,
      patternItemId: patternId,
      qtyPlan: 50,
    });

    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);
    const needs = calc.body.needs as Array<{ sourceType: string | null }>;
    expect(needs.some((n) => n.sourceType === 'PATTERN_PARAMETER_NORM')).toBe(
      false,
    );
  });

  // -------------------------------------------------------------------------
  // 4. PatternMaterialArea не используется для фурнитуры
  // -------------------------------------------------------------------------

  test('сохранение нормы НЕ создаёт строки в PatternMaterialArea', async () => {
    const cat = await createCategoryWithHardware();
    const lyversy = findParam(cat, 'Люверсы');
    const patternId = await createPatternWithCategory(
      cat.id,
      'P-NORM-NO-AREA',
    );

    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [{ categoryParameterId: lyversy.id, qtyPerItem: '2' }],
      })
      .expect(200);

    const areas = await t.prisma.patternMaterialArea.findMany({
      where: { patternItemId: patternId },
    });
    expect(areas).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. Снимок переживает удаление параметра категории
  // -------------------------------------------------------------------------

  test('Decimal qtyPerItem хранится с точностью до 4 знаков', async () => {
    // Прямой тест через Prisma — backend всегда нормализует входной
    // string к Decimal(14, 4), поэтому достаточно проверить, что
    // запись из БД совпадает с ожидаемым string-форматом.
    const cat = await createCategoryWithHardware();
    const lyversy = findParam(cat, 'Люверсы');
    const patternId = await createPatternWithCategory(
      cat.id,
      'P-NORM-DECIMAL',
    );

    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [{ categoryParameterId: lyversy.id, qtyPerItem: '0.5' }],
      })
      .expect(200);

    const norm = await t.prisma.patternItemParameterNorm.findFirst({
      where: { patternItemId: patternId },
    });
    expect(norm).not.toBeNull();
    expect(new Prisma.Decimal(norm!.qtyPerItem).toString()).toBe('0.5');
  });
});
