/**
 * Integration-тесты этапа «Исправить формирование Потребности цеха»
 * (см. ТЗ «Исправить формирование "Потребности цеха" после внедрения
 * категорий, погонных метров и подтягивания данных в техкарту»).
 *
 * Acceptance criteria:
 *   1. category-driven заказ НЕ создаёт лишних строк WorkshopNeed
 *      из техкарты;
 *   2. потребность создаётся только по заполненным параметрам
 *      номенклатуры (PARAMETER_NORM / SIZE_PARAMETER_VALUE /
 *      MATERIAL_AREA);
 *   3. техкарта обогащает description строки потребности (фабрик,
 *      ширина, плотность, размер фурнитуры, материал, цвет, картинка),
 *      но НЕ является источником количества;
 *   4. фурнитура (PACKAGING) получает в потребность размер /
 *      материал / цвет;
 *   5. для `colorRule = ORDER_SELECTED_COLOR` без selectedColorText
 *      есть warning «Цвет нужно указать в заказе»;
 *   6. legacy-заказ без категории / без параметров продолжает считать
 *      по техкарте, как раньше.
 *
 * Базовый seed: `seedMinimal` (admin + один продукт + размеры
 * S/M/L). Категории / лекала / техкарты создаём в каждом тесте
 * через REST API — это даёт sanity-проверку, что валидация / RBAC
 * на этих эндпоинтах отрабатывает по тому же контракту.
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

describeWithDb('integration — workshop needs category-driven', () => {
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
  // helpers (мини-аналог тестов patterns-parameter-norms /
  // patterns-size-parameter-values, но с отдельными именами/кодами,
  // чтобы тесты не пересекались).
  // -------------------------------------------------------------------------

  let catCounter = 0;

  /**
   * Категория «Худи»:
   *   - MAIN_FABRIC LINEAR_M_BY_SIZE «Основное полотно»;
   *   - LINING LINEAR_M_BY_SIZE «Подкладка»;
   *   - PACKAGING QTY_PER_ITEM «Молния».
   *
   * Это и есть classical category-driven setup из ТЗ Scenario A: ткани
   * через погонные метры по размерам, фурнитура — через норму на изделие.
   */
  async function createCategoryFull(): Promise<CategoryWithParams> {
    catCounter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: `Худи cat-driven ${catCounter}`,
        iconKey: 'HOODIE',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основное полотно',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
          {
            roleKey: 'LINING',
            label: 'Подкладка',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Молния',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
        ],
      })
      .expect(201);
    return { id: r.body.id, parameters: r.body.parameters };
  }

  /**
   * Категория с двумя QTY_PER_ITEM параметрами разных ролей —
   * специально для Scenario D (классификация секций):
   *   - PACKAGING / Люверсы (HARDWARE);
   *   - THREAD / Нитки (MATERIAL);
   *   - FILLER / Синтепон (MATERIAL).
   *
   * Все три параметра — `inputType = QTY_PER_ITEM`, чтобы доказать,
   * что классификатор смотрит на materialRole, а не только на
   * sourceType / calculationMethod.
   */
  async function createCategoryRoles(): Promise<CategoryWithParams> {
    catCounter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: `Худи roles ${catCounter}`,
        iconKey: 'HOODIE',
        parameters: [
          {
            roleKey: 'PACKAGING',
            label: 'Люверсы',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
          {
            roleKey: 'THREAD',
            label: 'Нитки',
            inputType: 'QTY_PER_ITEM',
            unit: 'м',
          },
          {
            roleKey: 'FILLER',
            label: 'Синтепон',
            inputType: 'QTY_PER_ITEM',
            unit: 'г',
          },
        ],
      })
      .expect(201);
    return { id: r.body.id, parameters: r.body.parameters };
  }

  function findParam(
    cat: CategoryWithParams,
    label: string,
  ): { id: string; roleKey: string; inputType: string } {
    const p = cat.parameters.find((x) => x.label === label);
    if (!p) throw new Error(`Параметр "${label}" не найден в категории`);
    return p;
  }

  let patternCounter = 0;
  async function createPattern(opts: {
    categoryId: string | null;
    article: string;
  }): Promise<string> {
    patternCounter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', t.adminCookie)
      .send({
        name: `Лекало cat-driven ${patternCounter}`,
        article: opts.article,
        categoryId: opts.categoryId ?? undefined,
      })
      .expect(201);
    return r.body.id as string;
  }

  let tcCounter = 0;
  async function createTechCard(body: {
    name: string;
    materialLines: Array<Record<string, unknown>>;
  }): Promise<string> {
    tcCounter += 1;
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', t.adminCookie)
      .send({
        code: `TC-CAT-DRV-${tcCounter}`,
        name: body.name,
        materialLines: body.materialLines,
      })
      .expect(201);
    return r.body.id as string;
  }

  async function createOrder(opts: {
    techCardId: string;
    patternItemId: string | null;
    items: Array<{ sizeId: string; qtyPlan: number }>;
    color?: string | null;
  }): Promise<string> {
    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: opts.items,
        techCardId: opts.techCardId,
        patternItemId: opts.patternItemId ?? undefined,
        color: opts.color ?? undefined,
      })
      .expect(201);
    return r.body.id as string;
  }

  // -------------------------------------------------------------------------
  // Scenario A: no extra techcard-only lines
  // -------------------------------------------------------------------------

  test('category-driven: лишние строки техкарты (Тафта/Синтепон) НЕ попадают в потребность', async () => {
    const cat = await createCategoryFull();
    const main = findParam(cat, 'Основное полотно');
    const molnija = findParam(cat, 'Молния');
    // ВАЖНО: LINING параметр у нас в категории есть, но значения по
    // нему не сохраняем — это и есть «параметр пустой» из ТЗ.
    const patternId = await createPattern({
      categoryId: cat.id,
      article: 'P-CAT-A',
    });

    // 1. Заполняем только MAIN_FABRIC — погонные метры.
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({
        values: [
          { categoryParameterId: main.id, sizeId: seed.sizes.M, value: '1.2' },
        ],
      })
      .expect(200);
    // 2. Заполняем только PACKAGING/Молния — норма на изделие.
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [{ categoryParameterId: molnija.id, qtyPerItem: '1' }],
      })
      .expect(200);
    // LINING (Подкладка) — пусто, никаких значений не сохраняем.

    // 3. Техкарта: четыре строки — MAIN_FABRIC (Дюспа), LINING (Тафта),
    //    FILLER (Синтепон), PACKAGING (Молния). По нашей бизнес-логике
    //    в потребность должны попасть ТОЛЬКО MAIN_FABRIC и PACKAGING —
    //    то есть строки, под которые есть заполненный параметр в
    //    номенклатуре. Тафта и Синтепон НЕ должны попасть.
    const tcId = await createTechCard({
      name: 'TC scenario A',
      materialLines: [
        {
          name: 'Дюспа',
          unit: 'м',
          qtyPerUnit: '1',
          materialRole: 'MAIN_FABRIC',
          fabricType: 'Дюспа',
          densityGsm: 90,
          plannedWidthCm: 140,
          colorRule: 'ORDER_COLOR',
        },
        {
          name: 'Тафта',
          unit: 'м',
          qtyPerUnit: '1',
          materialRole: 'LINING',
          fabricType: 'Тафта',
          densityGsm: 90,
          plannedWidthCm: 150,
        },
        {
          name: 'Синтепон',
          unit: 'г',
          qtyPerUnit: '100',
          materialRole: 'FILLER',
          fabricType: 'Синтепон',
        },
        {
          name: 'Молния',
          unit: 'шт',
          qtyPerUnit: '1',
          materialRole: 'PACKAGING',
          hardwareSizeText: '60 см',
          hardwareMaterialText: 'пластик',
          colorRule: 'ORDER_COLOR',
        },
      ],
    });

    const orderId = await createOrder({
      techCardId: tcId,
      patternItemId: patternId,
      items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
      color: 'бордо',
    });

    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);

    const needs = calc.body.needs as Array<{
      sourceType: string;
      sourceName: string;
      materialRole: string | null;
      description: string;
      calculatedQty: string;
      unit: string;
      hardwareSizeText: string | null;
      hardwareMaterialText: string | null;
      selectedColorText: string | null;
      requiresColorSelection: boolean;
      resolvedColorText: string | null;
    }>;

    // 4a. Лишних строк нет: всего две потребности (MAIN_FABRIC и PACKAGING).
    const sourceTypes = needs.map((n) => n.sourceType).sort();
    expect(sourceTypes).toEqual([
      'PATTERN_PARAMETER_NORM',
      'PATTERN_SIZE_PARAMETER_VALUE',
    ]);
    // Никакой строки Тафта / Синтепон в потребности нет.
    const names = needs.map((n) => n.sourceName);
    expect(names).not.toContain('Тафта');
    expect(names).not.toContain('Синтепон');

    // 4b. Описание основного полотна обогащено из техкарты (Дюспа,
    //     90 г/м², бордо, ширина 140 см).
    const main2 = needs.find((n) => n.materialRole === 'MAIN_FABRIC');
    expect(main2).toBeDefined();
    expect(main2!.description).toMatch(/Дюспа/);
    expect(main2!.description).toMatch(/90 г\/м²/);
    expect(main2!.description).toMatch(/бордо/);
    expect(main2!.description).toMatch(/ширина 140 см/);

    // 4c. Молния обогащена hardware-полями.
    const molnija2 = needs.find((n) => n.materialRole === 'PACKAGING');
    expect(molnija2).toBeDefined();
    expect(molnija2!.description).toMatch(/Молния/);
    expect(molnija2!.description).toMatch(/60 см/);
    expect(molnija2!.description).toMatch(/пластик/);
    // ORDER_COLOR + order.color = бордо.
    expect(molnija2!.description).toMatch(/бордо/);
    // 1 × 100 шт.
    expect(Number(molnija2!.calculatedQty)).toBeCloseTo(100, 4);
    // DTO-поля enrichment проброшены.
    expect(molnija2!.hardwareSizeText).toBe('60 см');
    expect(molnija2!.hardwareMaterialText).toBe('пластик');
  });

  // -------------------------------------------------------------------------
  // Scenario C: missing selected color → warning
  // -------------------------------------------------------------------------

  test('фурнитура с ORDER_SELECTED_COLOR без selectedColorText → calculationNote-warning', async () => {
    // Заводим только PACKAGING-параметр + техкарта-строку с ORDER_SELECTED_COLOR.
    catCounter += 1;
    const cat = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: `Худи цвет ${catCounter}`,
        iconKey: 'HOODIE',
        parameters: [
          {
            roleKey: 'PACKAGING',
            label: 'Молния',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
        ],
      })
      .expect(201);
    const molnija = (cat.body.parameters as CategoryWithParams['parameters']).find(
      (p) => p.label === 'Молния',
    )!;

    const patternId = await createPattern({
      categoryId: cat.body.id,
      article: 'P-CAT-C',
    });
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [{ categoryParameterId: molnija.id, qtyPerItem: '1' }],
      })
      .expect(200);

    const tcId = await createTechCard({
      name: 'TC scenario C',
      materialLines: [
        {
          name: 'Молния',
          unit: 'шт',
          qtyPerUnit: '1',
          materialRole: 'PACKAGING',
          hardwareSizeText: '60 см',
          hardwareMaterialText: 'пластик',
          colorRule: 'ORDER_SELECTED_COLOR',
        },
      ],
    });
    const orderId = await createOrder({
      techCardId: tcId,
      patternItemId: patternId,
      items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
      color: null,
    });

    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);

    const needs = calc.body.needs as Array<{
      materialRole: string;
      calculationNote: string | null;
      requiresColorSelection: boolean;
      selectedColorText: string | null;
      description: string;
    }>;
    const m = needs.find((n) => n.materialRole === 'PACKAGING');
    expect(m).toBeDefined();
    expect(m!.calculationNote).toMatch(/Цвет нужно указать в заказе/);
    expect(m!.requiresColorSelection).toBe(true);
    expect(m!.selectedColorText).toBeNull();
    // Description содержит размер и материал, но без цвета.
    expect(m!.description).toMatch(/Молния/);
    expect(m!.description).toMatch(/60 см/);
    expect(m!.description).toMatch(/пластик/);
    expect(m!.description).not.toMatch(/цвет /);
  });

  // -------------------------------------------------------------------------
  // Scenario D: section classification (HARDWARE vs MATERIAL by role)
  // -------------------------------------------------------------------------

  test('классификация секций: PACKAGING → HARDWARE, THREAD/FILLER → MATERIAL даже для QTY_PER_UNIT', async () => {
    const cat = await createCategoryRoles();
    const lyversy = findParam(cat, 'Люверсы');
    const nitki = findParam(cat, 'Нитки');
    const sintepon = findParam(cat, 'Синтепон');

    const patternId = await createPattern({
      categoryId: cat.id,
      article: 'P-CAT-D',
    });
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', t.adminCookie)
      .send({
        norms: [
          { categoryParameterId: lyversy.id, qtyPerItem: '4' },
          { categoryParameterId: nitki.id, qtyPerItem: '120' },
          { categoryParameterId: sintepon.id, qtyPerItem: '200' },
        ],
      })
      .expect(200);

    const tcId = await createTechCard({
      name: 'TC scenario D',
      materialLines: [{ name: 'placeholder', unit: 'шт', qtyPerUnit: '1' }],
    });
    const orderId = await createOrder({
      techCardId: tcId,
      patternItemId: patternId,
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
    });

    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);

    const needs = calc.body.needs as Array<{
      sourceType: string;
      sourceName: string;
      materialRole: string;
    }>;

    // Все три PARAMETER_NORM должны существовать.
    const norms = needs.filter((n) => n.sourceType === 'PATTERN_PARAMETER_NORM');
    expect(norms).toHaveLength(3);
    const byName = new Map(norms.map((n) => [n.sourceName, n]));
    expect(byName.get('Люверсы')?.materialRole).toBe('PACKAGING');
    expect(byName.get('Нитки')?.materialRole).toBe('THREAD');
    expect(byName.get('Синтепон')?.materialRole).toBe('FILLER');

    // UI-классификатор `getWorkshopNeedKind` живёт в shared, проверим
    // его через прямой импорт — для PACKAGING это HARDWARE, для
    // THREAD/FILLER — MATERIAL (даже несмотря на одинаковый
    // sourceType + calculationMethod).
    const { getWorkshopNeedKind } = await import('@sewing/shared/workshop-needs');
    expect(
      getWorkshopNeedKind({
        sourceType: 'PATTERN_PARAMETER_NORM',
        calculationMethod: 'QTY_PER_UNIT',
        materialRole: 'PACKAGING',
      }),
    ).toBe('HARDWARE');
    expect(
      getWorkshopNeedKind({
        sourceType: 'PATTERN_PARAMETER_NORM',
        calculationMethod: 'QTY_PER_UNIT',
        materialRole: 'THREAD',
      }),
    ).toBe('MATERIAL');
    expect(
      getWorkshopNeedKind({
        sourceType: 'PATTERN_PARAMETER_NORM',
        calculationMethod: 'QTY_PER_UNIT',
        materialRole: 'FILLER',
      }),
    ).toBe('MATERIAL');
  });

  // -------------------------------------------------------------------------
  // Scenario E: legacy techcard still works
  // -------------------------------------------------------------------------

  test('legacy: заказ без категории и без параметров продолжает считать по техкарте', async () => {
    // Лекало без категории.
    const patternId = await createPattern({
      categoryId: null,
      article: 'P-LEGACY-E',
    });

    // Старая техкарта в стиле «материал + материал», БЕЗ привязок
    // к новым полям (только базовые qtyPerUnit + название).
    const tcId = await createTechCard({
      name: 'TC legacy',
      materialLines: [
        { name: 'Нитки', unit: 'м', qtyPerUnit: '120' },
        { name: 'Пакет', unit: 'шт', qtyPerUnit: '1' },
      ],
    });

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

    const needs = calc.body.needs as Array<{
      sourceType: string;
      sourceName: string;
      calculatedQty: string;
    }>;
    // Обе строки техкарты создают потребность (legacy mode).
    expect(needs).toHaveLength(2);
    const byName = new Map(needs.map((n) => [n.sourceName, n]));
    // Этап «Указать в заказе» (см. ТЗ §2): snapshot
    // `OrderMaterialRequirement[]` теперь создаётся уже в
    // `OrdersService.create()`, поэтому при расчёте источник
    // строк — `ORDER_MATERIAL_REQUIREMENT` (а не live-техкарта).
    // Семантика расчёта не меняется: snapshot содержит те же
    // qtyPerUnit / unit / role.
    expect(byName.get('Нитки')?.sourceType).toBe(
      'ORDER_MATERIAL_REQUIREMENT',
    );
    expect(byName.get('Пакет')?.sourceType).toBe(
      'ORDER_MATERIAL_REQUIREMENT',
    );
    // Нитки: 120 × 50 = 6000.
    expect(Number(byName.get('Нитки')!.calculatedQty)).toBeCloseTo(6000, 4);
  });

  // -------------------------------------------------------------------------
  // Scenario E2: pattern с категорией, но без заполненных параметров —
  // тоже legacy (см. ТЗ §«Для legacy заказов / legacy номенклатур»).
  // -------------------------------------------------------------------------

  test('legacy fallback: pattern с categoryId, но БЕЗ заполненных параметров — техкарта по-прежнему создаёт строки', async () => {
    const cat = await createCategoryFull();
    const patternId = await createPattern({
      categoryId: cat.id,
      article: 'P-LEGACY-CAT',
    });
    // Никаких parameter-norms / size-parameter-values / materialAreas
    // не заполняем.
    const tcId = await createTechCard({
      name: 'TC legacy with cat',
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '5' }],
    });
    const orderId = await createOrder({
      techCardId: tcId,
      patternItemId: patternId,
      items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
    });

    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);

    const needs = calc.body.needs as Array<{ sourceType: string; sourceName: string }>;
    expect(needs).toHaveLength(1);
    // Этап «Указать в заказе» (см. ТЗ §2): snapshot материалов
    // создаётся уже в `OrdersService.create()`, поэтому
    // legacy-расчёт также читает snapshot.
    expect(needs[0]!.sourceType).toBe('ORDER_MATERIAL_REQUIREMENT');
    expect(needs[0]!.sourceName).toBe('Нитки');
  });
});
