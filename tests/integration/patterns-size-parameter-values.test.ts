/**
 * Integration-тесты этапа «Погонные метры по размерам» (см.
 * `apps/api/src/modules/patterns/patterns.service.ts::replaceSizeParameterValues`,
 * `apps/api/src/modules/workshop-needs/workshop-needs.service.ts::computeLinearBySizeParameter`,
 * `prisma/schema.prisma::PatternItemSizeParameterValue`).
 *
 * Acceptance ТЗ:
 *   1. Категория содержит MAIN_FABRIC LINEAR_M_BY_SIZE + RIB
 *      LINEAR_M_BY_SIZE + Люверсы (PACKAGING QTY_PER_ITEM).
 *   2. Лекало с этой категорией.
 *   3. Активные размеры M/L (через PatternSizeFile со status=ACTIVE).
 *   4. PUT /api/patterns/:id/size-parameter-values сохраняет значения.
 *   5. Создаём заказ M=10, L=5.
 *   6. POST /api/orders/:id/workshop-needs/calculate.
 *   7. WorkshopNeed:
 *      - Основное полотно = 1.2*10 + 1.4*5 = 19 м пог.
 *      - Рибана           = 0.3*10 + 0.35*5 = 4.75 м пог.
 *      - Каждая = одна строка с sourceType = PATTERN_SIZE_PARAMETER_VALUE.
 *   8. QTY_PER_ITEM фурнитура продолжает работать (через
 *      PatternItemParameterNorm).
 *
 * Защитные случаи:
 *   - попытка сохранить значение по QTY_PER_ITEM параметру → 422
 *     PATTERN_SIZE_PARAMETER_VALUE_NOT_ALLOWED;
 *   - попытка сохранить значение по параметру другой категории → 422.
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

interface CategoryWithParams {
  id: string;
  parameters: Array<{
    id: string;
    roleKey: string;
    label: string;
    inputType: string;
  }>;
}

describeWithDb('integration — pattern item size parameter values', () => {
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
  async function createCategoryWithLinear(
    nameSuffix?: string,
  ): Promise<CategoryWithParams> {
    catCounter += 1;
    const name = nameSuffix
      ? `Худи погонка ${nameSuffix}`
      : `Худи погонка ${catCounter}`;
    const r = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name,
        iconKey: 'HOODIE',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основное полотно',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
          {
            roleKey: 'RIB',
            label: 'Рибана / кашкорсе',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Люверсы',
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
        name: 'Худи погонка',
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

  /**
   * Чтобы заказ умел тащить активные размеры через лекало, нам нужны
   * `PatternSizeFile` со `status = ACTIVE`. На MVP физически файлы не
   * нужны для расчёта `WorkshopNeed` — backend читает только
   * `materialAreas`, `parameterNorms` и `sizeParameterValues` —
   * поэтому пишем «фейковую» запись напрямую через Prisma.
   */
  async function attachActiveSizeFile(
    patternItemId: string,
    sizeId: string,
  ): Promise<void> {
    await t.prisma.patternSizeFile.create({
      data: {
        patternItemId,
        sizeId,
        fileUrl: `/uploads/patterns/${patternItemId}/sizes/${sizeId}/test.dxf`,
        originalFileName: 'test.dxf',
        version: 1,
        status: 'ACTIVE',
      },
    });
  }

  let tcCounter = 0;
  async function createTechCardSimple(): Promise<string> {
    tcCounter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', t.adminCookie)
      .send({
        code: `TC-LIN-${tcCounter}`,
        name: 'Tech card simple',
        materialLines: [
          { name: 'Нитки', unit: 'м', qtyPerUnit: '0.5' },
        ],
      })
      .expect(201);
    return r.body.id as string;
  }

  /**
   * Техкарта с MAIN_FABRIC-строкой (Кулирка, ширина 180 см, плотность
   * 180 г/м²). Используется в тестах конверсии «м пог. → кг / м²» для
   * параметра категории `MAIN_FABRIC LINEAR_M_BY_SIZE`.
   *
   * Параметры `widthCm` / `densityGsm` опциональны: если не передать,
   * получим техкарту без этих полей — для проверки warning-flow при
   * нехватке данных пересчёта.
   */
  async function createTechCardWithMainFabric(opts: {
    widthCm?: number | null;
    densityGsm?: number | null;
  } = {}): Promise<string> {
    tcCounter += 1;
    const widthCm = opts.widthCm === undefined ? 180 : opts.widthCm;
    const densityGsm =
      opts.densityGsm === undefined ? 180 : opts.densityGsm;
    const mainLine: Record<string, unknown> = {
      name: 'Кулирка',
      unit: 'кг',
      qtyPerUnit: '0.001',
      materialRole: 'MAIN_FABRIC',
      fabricType: 'Кулирка',
    };
    if (widthCm != null) mainLine.plannedWidthCm = widthCm;
    if (densityGsm != null) mainLine.densityGsm = densityGsm;
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', t.adminCookie)
      .send({
        code: `TC-LIN-MAIN-${tcCounter}`,
        name: 'Tech card MAIN_FABRIC',
        materialLines: [mainLine],
      })
      .expect(201);
    return r.body.id as string;
  }

  /**
   * Категория с одним LINEAR_M_BY_SIZE-параметром MAIN_FABRIC и
   * заданной единицей потребности. По умолчанию `unit = 'кг'`
   * (новая семантика, см. ТЗ «Исправить смысл LINEAR_M_BY_SIZE»).
   */
  async function createCategoryMainFabricOnly(
    unit: string,
  ): Promise<CategoryWithParams> {
    catCounter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: `Футболка ${unit} ${catCounter}`,
        iconKey: 'SHIRT',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основное полотно',
            inputType: 'LINEAR_M_BY_SIZE',
            unit,
          },
        ],
      })
      .expect(201);
    return { id: r.body.id, parameters: r.body.parameters };
  }

  async function createOrder(opts: {
    techCardId: string;
    patternItemId: string;
    items: Array<{ sizeId: string; qtyPlan: number }>;
  }): Promise<string> {
    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        clientId: seed.client.id,
        productId: seed.product.id,
        items: opts.items,
        techCardId: opts.techCardId,
        patternItemId: opts.patternItemId,
      })
      .expect(201);
    return r.body.id as string;
  }

  // -------------------------------------------------------------------------
  // 1. Сохранение значений + GET /patterns/:id отдаёт sizeParameterValues
  // -------------------------------------------------------------------------

  test('PUT /api/patterns/:id/size-parameter-values сохраняет значения и они приходят в GET', async () => {
    const cat = await createCategoryWithLinear();
    const main = findParam(cat, 'Основное полотно');
    const rib = findParam(cat, 'Рибана / кашкорсе');
    const patternId = await createPatternWithCategory(cat.id, 'P-LIN-OK');

    const put = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({
        values: [
          { categoryParameterId: main.id, sizeId: seed.sizes.M, value: '1.2' },
          { categoryParameterId: main.id, sizeId: seed.sizes.L, value: '1.4' },
          { categoryParameterId: rib.id, sizeId: seed.sizes.M, value: '0.3' },
          { categoryParameterId: rib.id, sizeId: seed.sizes.L, value: '0.35' },
        ],
      })
      .expect(200);
    expect(put.body.sizeParameterValues).toHaveLength(4);

    const got = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    const values = got.body.sizeParameterValues as Array<{
      id: string;
      categoryParameterId: string;
      sizeId: string;
      roleKey: string;
      labelSnapshot: string;
      inputTypeSnapshot: string;
      value: string;
      unit: string;
    }>;
    expect(values).toHaveLength(4);
    // Snapshot полей.
    for (const v of values) {
      expect(v.inputTypeSnapshot).toBe('LINEAR_M_BY_SIZE');
      expect(v.unit).toBe('м пог.');
    }
    // Конкретные числа по тройкам (param, size).
    const byKey = new Map(
      values.map((v) => [`${v.categoryParameterId}::${v.sizeId}`, v]),
    );
    expect(byKey.get(`${main.id}::${seed.sizes.M}`)?.value).toBe('1.2');
    expect(byKey.get(`${main.id}::${seed.sizes.L}`)?.value).toBe('1.4');
    expect(byKey.get(`${rib.id}::${seed.sizes.M}`)?.value).toBe('0.3');
    expect(byKey.get(`${rib.id}::${seed.sizes.L}`)?.value).toBe('0.35');

    // Аудит-событие.
    const audit = await t.prisma.auditLog.findFirst({
      where: {
        event: 'PATTERN_SIZE_PARAMETER_VALUES_REPLACED',
        entityId: patternId,
      },
    });
    expect(audit).not.toBeNull();
  });

  test('повторный PUT перезаписывает значения: пустой payload очищает', async () => {
    const cat = await createCategoryWithLinear();
    const main = findParam(cat, 'Основное полотно');
    const patternId = await createPatternWithCategory(cat.id, 'P-LIN-CLR');

    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({
        values: [
          { categoryParameterId: main.id, sizeId: seed.sizes.M, value: '5' },
        ],
      })
      .expect(200);

    const cleared = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({ values: [] })
      .expect(200);
    expect(cleared.body.sizeParameterValues).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. Защитные случаи (422 PATTERN_SIZE_PARAMETER_VALUE_NOT_ALLOWED)
  // -------------------------------------------------------------------------

  test('QTY_PER_ITEM параметр нельзя сохранить как size value (422)', async () => {
    const cat = await createCategoryWithLinear();
    const lyversy = findParam(cat, 'Люверсы');
    const patternId = await createPatternWithCategory(cat.id, 'P-LIN-QTY');

    const r = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({
        values: [
          { categoryParameterId: lyversy.id, sizeId: seed.sizes.M, value: '1' },
        ],
      })
      .expect(422);
    expect(r.body.code).toBe('PATTERN_SIZE_PARAMETER_VALUE_NOT_ALLOWED');
  });

  test('параметр другой категории — 422', async () => {
    const cat = await createCategoryWithLinear();
    const other = await createCategoryWithLinear('other');
    const otherMain = findParam(other, 'Основное полотно');
    const patternId = await createPatternWithCategory(cat.id, 'P-LIN-OTHER');

    const r = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({
        values: [
          { categoryParameterId: otherMain.id, sizeId: seed.sizes.M, value: '1' },
        ],
      })
      .expect(422);
    expect(r.body.code).toBe('PATTERN_SIZE_PARAMETER_VALUE_NOT_ALLOWED');
  });

  test('лекало без categoryId — любой параметр отбивается 422', async () => {
    const cat = await createCategoryWithLinear();
    const main = findParam(cat, 'Основное полотно');
    const patternId = await createPatternWithCategory(null, 'P-LIN-NOCAT');

    // GET всё равно работает и sizeParameterValues = [].
    const got = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    expect(got.body.categoryId).toBeNull();
    expect(got.body.sizeParameterValues).toEqual([]);

    const r = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({
        values: [
          { categoryParameterId: main.id, sizeId: seed.sizes.M, value: '1' },
        ],
      })
      .expect(422);
    expect(r.body.code).toBe('PATTERN_SIZE_PARAMETER_VALUE_NOT_ALLOWED');
  });

  test('value ≤ 0 отбивается Zod-ом', async () => {
    const cat = await createCategoryWithLinear();
    const main = findParam(cat, 'Основное полотно');
    const patternId = await createPatternWithCategory(cat.id, 'P-LIN-NEG');

    const r = await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({
        values: [
          { categoryParameterId: main.id, sizeId: seed.sizes.M, value: '0' },
        ],
      });
    expect(r.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 3. WorkshopNeed: один LINEAR_M_BY_SIZE параметр → одна строка
  // -------------------------------------------------------------------------

  test('start-calculation: WorkshopNeed по каждому LINEAR_M_BY_SIZE параметру (одна строка на параметр)', async () => {
    const cat = await createCategoryWithLinear();
    const main = findParam(cat, 'Основное полотно');
    const rib = findParam(cat, 'Рибана / кашкорсе');
    const lyversy = findParam(cat, 'Люверсы');
    const patternId = await createPatternWithCategory(cat.id, 'P-LIN-WN');

    // Сохраняем погонные метры: M основное 1.2, L основное 1.4,
    // M рибана 0.3, L рибана 0.35. Плюс норма «Люверсы 2 шт» —
    // QTY_PER_ITEM, чтобы доказать, что фурнитура продолжает работать.
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({
        values: [
          { categoryParameterId: main.id, sizeId: seed.sizes.M, value: '1.2' },
          { categoryParameterId: main.id, sizeId: seed.sizes.L, value: '1.4' },
          { categoryParameterId: rib.id, sizeId: seed.sizes.M, value: '0.3' },
          { categoryParameterId: rib.id, sizeId: seed.sizes.L, value: '0.35' },
        ],
      })
      .expect(200);

    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [{ categoryParameterId: lyversy.id, qtyPerItem: '2' }],
      })
      .expect(200);

    // Прицепим активные размеры через PatternSizeFile (M/L).
    await attachActiveSizeFile(patternId, seed.sizes.M);
    await attachActiveSizeFile(patternId, seed.sizes.L);

    const tcId = await createTechCardSimple();
    const orderId = await createOrder({
      techCardId: tcId,
      patternItemId: patternId,
      items: [
        { sizeId: seed.sizes.M, qtyPlan: 10 },
        { sizeId: seed.sizes.L, qtyPlan: 5 },
      ],
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

    // Должны быть строки от LINEAR_M_BY_SIZE — по одной на параметр.
    const linearNeeds = needs.filter(
      (n) => n.sourceType === 'PATTERN_SIZE_PARAMETER_VALUE',
    );
    expect(linearNeeds).toHaveLength(2);

    const byLabel = new Map(linearNeeds.map((n) => [n.sourceName, n]));
    const mainNeed = byLabel.get('Основное полотно');
    const ribNeed = byLabel.get('Рибана / кашкорсе');
    expect(mainNeed).toBeDefined();
    expect(ribNeed).toBeDefined();

    // Основное полотно: 1.2*10 + 1.4*5 = 19 м пог.
    expect(Number(mainNeed!.calculatedQty)).toBeCloseTo(19, 4);
    expect(mainNeed!.unit).toBe('м пог.');
    expect(mainNeed!.calculationMethod).toBe('LINEAR_M_BY_SIZE');
    expect(mainNeed!.materialRole).toBe('MAIN_FABRIC');

    // Рибана: 0.3*10 + 0.35*5 = 4.75 м пог.
    expect(Number(ribNeed!.calculatedQty)).toBeCloseTo(4.75, 4);
    expect(ribNeed!.unit).toBe('м пог.');
    expect(ribNeed!.materialRole).toBe('RIB');

    // QTY_PER_ITEM фурнитура продолжает считаться через
    // `PatternItemParameterNorm`. Люверсы = 2 × (10+5) = 30 шт.
    const normNeeds = needs.filter(
      (n) => n.sourceType === 'PATTERN_PARAMETER_NORM',
    );
    expect(normNeeds).toHaveLength(1);
    expect(normNeeds[0]!.materialRole).toBe('PACKAGING');
    expect(normNeeds[0]!.sourceName).toBe('Люверсы');
    expect(Number(normNeeds[0]!.calculatedQty)).toBeCloseTo(30, 4);
    expect(normNeeds[0]!.unit).toBe('шт');
  });

  test('лекало без LINEAR_M_BY_SIZE значений — WorkshopNeed по погонным метрам не создаются', async () => {
    const cat = await createCategoryWithLinear();
    const patternId = await createPatternWithCategory(cat.id, 'P-LIN-NONE');
    await attachActiveSizeFile(patternId, seed.sizes.M);

    const tcId = await createTechCardSimple();
    const orderId = await createOrder({
      techCardId: tcId,
      patternItemId: patternId,
      items: [{ sizeId: seed.sizes.M, qtyPlan: 50 }],
    });

    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);
    const needs = calc.body.needs as Array<{ sourceType: string | null }>;
    expect(
      needs.some((n) => n.sourceType === 'PATTERN_SIZE_PARAMETER_VALUE'),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. PatternMaterialArea не используется для погонных метров
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 3a. WorkshopNeed конверсия м пог. → кг / м² через техкарту
  //     (этап «Исправить смысл и расчёт LINEAR_M_BY_SIZE»)
  // -------------------------------------------------------------------------

  /**
   * Хелпер: создаёт лекало с MAIN_FABRIC LINEAR_M_BY_SIZE-параметром
   * и значениями погонных метров по M/L (0.85 м пог. на изделие
   * по обоим размерам — для удобной проверки 0.85 × (10 + 5) = 12.75
   * погонных метров).
   */
  async function setupConversionScenario(opts: {
    unit: 'кг' | 'м пог.' | 'м²' | 'г';
    widthCm?: number | null;
    densityGsm?: number | null;
  }): Promise<{
    orderId: string;
    main: { id: string; roleKey: string; inputType: string };
  }> {
    const cat = await createCategoryMainFabricOnly(opts.unit);
    const main = findParam(cat, 'Основное полотно');
    const patternId = await createPatternWithCategory(
      cat.id,
      `P-LIN-CONV-${opts.unit}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
    );

    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({
        values: [
          { categoryParameterId: main.id, sizeId: seed.sizes.M, value: '0.85' },
          { categoryParameterId: main.id, sizeId: seed.sizes.L, value: '0.85' },
        ],
      })
      .expect(200);

    await attachActiveSizeFile(patternId, seed.sizes.M);
    await attachActiveSizeFile(patternId, seed.sizes.L);

    const tcId = await createTechCardWithMainFabric({
      widthCm: opts.widthCm,
      densityGsm: opts.densityGsm,
    });
    const orderId = await createOrder({
      techCardId: tcId,
      patternItemId: patternId,
      items: [
        { sizeId: seed.sizes.M, qtyPlan: 10 },
        { sizeId: seed.sizes.L, qtyPlan: 5 },
      ],
    });
    return { orderId, main };
  }

  test('outputUnit = кг: считает через ширину и плотность техкарты', async () => {
    // Σ погонных метров = 0.85 × 10 + 0.85 × 5 = 12.75 м пог.
    // areaM2 = 12.75 × 1.8 м = 22.95 м².
    // kg     = 22.95 × 180 г/м² / 1000 = 4.131 кг.
    const { orderId } = await setupConversionScenario({
      unit: 'кг',
      widthCm: 180,
      densityGsm: 180,
    });
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);
    const linear = (
      calc.body.needs as Array<{
        sourceType: string;
        unit: string;
        calculatedQty: string;
        calculationMethod: string;
        materialRole: string;
        description: string;
      }>
    ).filter((n) => n.sourceType === 'PATTERN_SIZE_PARAMETER_VALUE');
    expect(linear).toHaveLength(1);
    const need = linear[0]!;
    expect(need.unit).toBe('кг');
    expect(need.calculationMethod).toBe('LINEAR_M_BY_SIZE');
    expect(need.materialRole).toBe('MAIN_FABRIC');
    expect(Number(need.calculatedQty)).toBeCloseTo(4.131, 3);
    // Описание собрано из техкартовой строки (Кулирка 180 г/м² ширина 180 см).
    expect(need.description).toMatch(/Кулирка/);
    expect(need.description).toMatch(/180/);
  });

  test('outputUnit = м²: считает через ширину техкарты', async () => {
    // areaM2 = 12.75 × 1.8 = 22.95 м².
    const { orderId } = await setupConversionScenario({
      unit: 'м²',
      widthCm: 180,
      densityGsm: 180,
    });
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);
    const need = (
      calc.body.needs as Array<{
        sourceType: string;
        unit: string;
        calculatedQty: string;
      }>
    ).find((n) => n.sourceType === 'PATTERN_SIZE_PARAMETER_VALUE')!;
    expect(need.unit).toBe('м²');
    expect(Number(need.calculatedQty)).toBeCloseTo(22.95, 4);
  });

  test('outputUnit = м пог.: считает raw погонные метры (без ширины/плотности)', async () => {
    // calculatedQty = rawLinearM = 12.75
    const { orderId } = await setupConversionScenario({
      unit: 'м пог.',
      widthCm: null,
      densityGsm: null,
    });
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);
    const need = (
      calc.body.needs as Array<{
        sourceType: string;
        unit: string;
        calculatedQty: string;
      }>
    ).find((n) => n.sourceType === 'PATTERN_SIZE_PARAMETER_VALUE')!;
    expect(need.unit).toBe('м пог.');
    expect(Number(need.calculatedQty)).toBeCloseTo(12.75, 4);
  });

  test('outputUnit = кг, нет ширины: warning, calculatedQty = 0', async () => {
    const { orderId } = await setupConversionScenario({
      unit: 'кг',
      widthCm: null,
      densityGsm: 180,
    });
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);
    const need = (
      calc.body.needs as Array<{
        sourceType: string;
        unit: string;
        calculatedQty: string;
        calculationNote: string | null;
      }>
    ).find((n) => n.sourceType === 'PATTERN_SIZE_PARAMETER_VALUE')!;
    expect(need.unit).toBe('кг');
    expect(Number(need.calculatedQty)).toBe(0);
    expect(need.calculationNote ?? '').toMatch(/ширина/i);
    // В warnings calc-результата тоже есть упоминание.
    expect(
      (calc.body.warnings as string[]).some((w: string) =>
        /ширина/i.test(w),
      ),
    ).toBe(true);
  });

  test('outputUnit = кг, нет плотности: warning, calculatedQty = 0', async () => {
    const { orderId } = await setupConversionScenario({
      unit: 'кг',
      widthCm: 180,
      densityGsm: null,
    });
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);
    const need = (
      calc.body.needs as Array<{
        sourceType: string;
        calculatedQty: string;
        calculationNote: string | null;
      }>
    ).find((n) => n.sourceType === 'PATTERN_SIZE_PARAMETER_VALUE')!;
    expect(Number(need.calculatedQty)).toBe(0);
    expect(need.calculationNote ?? '').toMatch(/плотность/i);
    expect(
      (calc.body.warnings as string[]).some((w: string) =>
        /плотность/i.test(w),
      ),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. PatternMaterialArea не используется для погонных метров
  // -------------------------------------------------------------------------

  test('сохранение size value НЕ создаёт строки в PatternMaterialArea', async () => {
    const cat = await createCategoryWithLinear();
    const main = findParam(cat, 'Основное полотно');
    const patternId = await createPatternWithCategory(
      cat.id,
      'P-LIN-NO-AREA',
    );

    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({
        values: [
          { categoryParameterId: main.id, sizeId: seed.sizes.M, value: '1.2' },
        ],
      })
      .expect(200);

    const areas = await t.prisma.patternMaterialArea.findMany({
      where: { patternItemId: patternId },
    });
    expect(areas).toHaveLength(0);

    const linearRows = await t.prisma.patternItemSizeParameterValue.findMany({
      where: { patternItemId: patternId },
    });
    expect(linearRows).toHaveLength(1);
  });
});
