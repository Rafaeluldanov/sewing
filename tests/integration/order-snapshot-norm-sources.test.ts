/**
 * Регрессия «Аудит движка расчёта 13.09.2026», срез T1 — снимок материалов
 * заказа ↔ нормы номенклатуры (`OrdersService.rebuildMaterialRequirementsSnapshot`,
 * `recomputeSnapshotGroup`, `retryLinearNormMatch`).
 *
 *   T1-3. Смена размерного плана на размеры, которых в номенклатуре нет:
 *         recompute обязан снять метку «из номенклатуры» (метка и число
 *         решаются одним условием — выведенной нормой, как в материализации)
 *         и не молчать — отметка на заказе (`needsStaleReason`).
 *   T1-4. Второй заход сопоставления (авто-расщепление единиц) не получает
 *         источники, занятые первым: «Кашкорсе» (кг) не берёт норму «Рибаны».
 *   T1-8. Обнуление тиража одной расцветки не сносит её шаблонные строки и
 *         слоты; возврат тиража находит правки заказа (ORDER-норма,
 *         фиксированный цвет, значение слота) на месте.
 *
 * Спецификация читается через GET /orders/:id/tech-card-parameters,
 * потребность — через POST /orders/:id/workshop-needs/calculate.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';

import { refreshAdminCookie, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { copySpecLinesTo, createSpecPattern, type SpecLineInput } from '../utils/spec';

interface SpecLine {
  id: string;
  name: string;
  unit: string;
  normUnit: string | null;
  qtyPerUnit: string;
  totalQty: string;
  materialRole: string | null;
  qtySource: string | null;
  qtySourceLabel: string | null;
  qtyBySize: Array<{ sizeCode: string; value: string; qtyPlan: number }>;
  colorText: string | null;
  densityGsm: number | null;
  isManual: boolean;
}
interface ParamDto {
  id: string;
  key: string;
  value: string | null;
  valueSource: string;
}
interface VariantDto {
  orderVariantId: string | null;
  color: string | null;
  parameters: ParamDto[];
  lines: SpecLine[];
}
interface NeedRow {
  sourceType: string;
  sourceName: string | null;
  materialRole: string | null;
  calculatedQty: string;
  unit: string;
}

describeWithDb('integration — снимок материалов: нормы номенклатуры (T1-3, T1-4, T1-8)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let n = 0;

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

  const api = () => request(t.app.getHttpServer());

  /** Категория с LINEAR-параметрами; возвращает id параметров по label. */
  async function category(
    params: Array<{ roleKey: string; label: string }>,
  ): Promise<{ id: string; byLabel: Record<string, string> }> {
    n += 1;
    const r = await api()
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: `T1 cat ${n}`,
        iconKey: 'HOODIE',
        parameters: params.map((p) => ({ ...p, inputType: 'LINEAR_M_BY_SIZE', unit: 'м пог.' })),
      })
      .expect(201);
    const byLabel: Record<string, string> = {};
    for (const p of r.body.parameters as Array<{ id: string; label: string }>) byLabel[p.label] = p.id;
    return { id: r.body.id, byLabel };
  }

  /** Лекало категории с поразмерными нормами и спецификацией материалов. */
  async function pattern(
    categoryId: string,
    values: Array<{ categoryParameterId: string; sizeId: string; value: string }>,
    spec: SpecLineInput[],
  ): Promise<string> {
    n += 1;
    const p = await api()
      .post('/api/patterns')
      .set('Cookie', t.adminCookie)
      .send({ name: `T1 лекало ${n}`, article: `T1-SZ-${n}`, categoryId })
      .expect(201);
    const patternId = p.body.id as string;
    await api()
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({ values })
      .expect(200);
    const s = await createSpecPattern(t, t.adminCookie, {
      article: `T1-SZ-SPEC-${n}`,
      name: `T1 spec ${n}`,
      materialLines: spec,
    });
    await copySpecLinesTo(t, s.id, patternId);
    return patternId;
  }

  async function createOrder(patternItemId: string, body: Record<string, unknown>): Promise<string> {
    const r = await api()
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-09-13T00:00:00.000Z',
        productId: seed.product.id,
        clientId: seed.client.id,
        patternItemId,
        color: 'серый',
        ...body,
      })
      .expect(201);
    return r.body.id as string;
  }

  async function techCard(orderId: string): Promise<VariantDto[]> {
    const r = await api()
      .get(`/api/orders/${orderId}/tech-card-parameters`)
      .set('Cookie', t.adminCookie)
      .expect(200);
    return r.body.variants as VariantDto[];
  }

  async function specLines(orderId: string): Promise<SpecLine[]> {
    return (await techCard(orderId)).flatMap((v) => v.lines);
  }

  async function calculate(orderId: string): Promise<{ needs: NeedRow[]; warnings: string[] }> {
    const r = await api()
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);
    return { needs: r.body.needs as NeedRow[], warnings: r.body.warnings as string[] };
  }

  const KULIRKA: SpecLineInput = {
    name: 'Кулирка',
    unit: 'м пог.',
    qtyPerUnit: '1',
    materialRole: 'MAIN_FABRIC',
    fabricType: 'Кулирка',
    colorRule: 'ORDER_COLOR',
  };

  // ---------------------------------------------------------------------------
  // T1-3
  // ---------------------------------------------------------------------------
  test('T1-3: план сменили на размер без нормы — строка честно «из шаблона», заказ получает отметку', async () => {
    const cat = await category([{ roleKey: 'MAIN_FABRIC', label: 'Кулирка' }]);
    const pid = await pattern(
      cat.id,
      [
        { categoryParameterId: cat.byLabel['Кулирка'], sizeId: seed.sizes.S, value: '0.8' },
        { categoryParameterId: cat.byLabel['Кулирка'], sizeId: seed.sizes.M, value: '1.1' },
      ],
      [KULIRKA],
    );
    const orderId = await createOrder(pid, { items: [{ sizeId: seed.sizes.S, qtyPlan: 100 }] });
    const before = (await specLines(orderId)).find((l) => l.name === 'Кулирка')!;
    expect(before.qtySource).toBe('NOMENCLATURE');
    expect(Number(before.qtyPerUnit)).toBeCloseTo(0.8, 4);

    // План → L (в карточке не заполнен): DRAFT → пересборка снимка, recompute-ветка.
    await api()
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', t.adminCookie)
      .send({ items: [{ sizeId: seed.sizes.L, qtyPlan: 100 }] })
      .expect(200);

    const after = (await specLines(orderId)).find((l) => l.name === 'Кулирка')!;
    // Метка и число решаются одним условием — выведенной нормой: нормы нет →
    // «из шаблона», подписи источника нет, разбивки по размерам нет.
    expect(after.qtySource).toBe('TEMPLATE');
    expect(after.qtySourceLabel).toBeNull();
    expect(after.qtyBySize).toHaveLength(0);
    const dbRow = await t.prisma.orderMaterialRequirement.findFirstOrThrow({
      where: { orderId, name: 'Кулирка' },
      select: { qtySource: true, qtySourceRef: true },
    });
    expect(dbRow.qtySource).toBe('TEMPLATE');
    expect(dbRow.qtySourceRef).toBeNull();

    // Не молчим: отметка на заказе называет строку.
    const order = await t.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { needsStaleAt: true, needsStaleReason: true },
    });
    expect(order.needsStaleAt).not.toBeNull();
    expect(order.needsStaleReason ?? '').toContain('«Кулирка»');
    expect(order.needsStaleReason ?? '').toMatch(/не покрывает размерный план/u);

    // Симметрия с материализацией: заказ, созданный сразу с L, — та же метка.
    const freshId = await createOrder(pid, { items: [{ sizeId: seed.sizes.L, qtyPlan: 100 }] });
    const fresh = (await specLines(freshId)).find((l) => l.name === 'Кулирка')!;
    expect(fresh.qtySource).toBe('TEMPLATE');
    expect(fresh.qtySourceLabel).toBeNull();
  });

  test('T1-3 (контроль): план сменили на размер С нормой — строка остаётся «из номенклатуры», отметки нет', async () => {
    const cat = await category([{ roleKey: 'MAIN_FABRIC', label: 'Кулирка' }]);
    const pid = await pattern(
      cat.id,
      [
        { categoryParameterId: cat.byLabel['Кулирка'], sizeId: seed.sizes.S, value: '0.8' },
        { categoryParameterId: cat.byLabel['Кулирка'], sizeId: seed.sizes.M, value: '1.1' },
      ],
      [KULIRKA],
    );
    const orderId = await createOrder(pid, { items: [{ sizeId: seed.sizes.S, qtyPlan: 100 }] });
    await api()
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', t.adminCookie)
      .send({ items: [{ sizeId: seed.sizes.M, qtyPlan: 50 }] })
      .expect(200);
    const after = (await specLines(orderId)).find((l) => l.name === 'Кулирка')!;
    expect(after.qtySource).toBe('NOMENCLATURE');
    expect(Number(after.qtyPerUnit)).toBeCloseTo(1.1, 4);
    expect(Number(after.totalQty)).toBeCloseTo(55, 4);
    const order = await t.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { needsStaleAt: true },
    });
    expect(order.needsStaleAt).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // T1-4
  // ---------------------------------------------------------------------------
  test('T1-4: второй заход не отдаёт занятый источник — «Кашкорсе» (кг) остаётся из шаблона без нормы «Рибаны»', async () => {
    const cat = await category([{ roleKey: 'RIB', label: 'Рибана' }]);
    const pid = await pattern(
      cat.id,
      [{ categoryParameterId: cat.byLabel['Рибана'], sizeId: seed.sizes.M, value: '0.2' }],
      [
        { name: 'Рибана', unit: 'м пог.', qtyPerUnit: '1', materialRole: 'RIB', fabricType: 'Рибана', colorRule: 'ORDER_COLOR' },
        {
          name: 'Кашкорсе',
          unit: 'кг',
          qtyPerUnit: '1',
          materialRole: 'RIB',
          fabricType: 'Кашкорсе',
          densityGsm: 220,
          plannedWidthCm: 166,
          colorRule: 'ORDER_COLOR',
        },
      ],
    );
    const orderId = await createOrder(pid, { items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }] });
    const lines = await specLines(orderId);
    const rib = lines.find((l) => l.name === 'Рибана')!;
    const kash = lines.find((l) => l.name === 'Кашкорсе')!;

    // Первый заход спарил «Рибану» с параметром «Рибана».
    expect(rib.qtySource).toBe('NOMENCLATURE');
    expect(Number(rib.qtyPerUnit)).toBeCloseTo(0.2, 4);
    expect(Number(rib.totalQty)).toBeCloseTo(20, 4);

    // Второй заход занятый источник не видит: «Кашкорсе» живёт по шаблону —
    // 1 кг/шт × 100, единица нормы не расщеплена, ссылки на источник нет.
    expect(kash.qtySource).toBe('TEMPLATE');
    expect(kash.qtySourceLabel).toBeNull();
    expect(kash.normUnit).toBeNull();
    expect(Number(kash.qtyPerUnit)).toBeCloseTo(1, 4);
    expect(Number(kash.totalQty)).toBeCloseTo(100, 4);

    const dbRows = await t.prisma.orderMaterialRequirement.findMany({
      where: { orderId },
      select: { name: true, qtySourceRef: true },
    });
    expect(dbRows.find((r) => r.name === 'Рибана')?.qtySourceRef).toBe(cat.byLabel['Рибана']);
    expect(dbRows.find((r) => r.name === 'Кашкорсе')?.qtySourceRef).toBeNull();

    // Потребность по роли RIB — одна строка «Рибана» 20 м пог., как и раньше.
    const calc = await calculate(orderId);
    const ribNeeds = calc.needs.filter((x) => x.materialRole === 'RIB');
    expect(ribNeeds).toHaveLength(1);
    expect(Number(ribNeeds[0]!.calculatedQty)).toBeCloseTo(20, 4);
  });

  test('T1-4 (контроль): свободный источник роли второй заход по-прежнему отдаёт строке в «кг»', async () => {
    // Единственная строка роли в «кг» и единственный источник — расщепление
    // единиц (норма в метрах, закупка в кг) работает как до правки.
    const cat = await category([{ roleKey: 'RIB', label: 'Кашкорсе' }]);
    const pid = await pattern(
      cat.id,
      [{ categoryParameterId: cat.byLabel['Кашкорсе'], sizeId: seed.sizes.M, value: '0.2' }],
      [
        {
          name: 'Кашкорсе',
          unit: 'кг',
          qtyPerUnit: '1',
          materialRole: 'RIB',
          fabricType: 'Кашкорсе',
          densityGsm: 220,
          plannedWidthCm: 166,
          colorRule: 'ORDER_COLOR',
        },
      ],
    );
    const orderId = await createOrder(pid, { items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }] });
    const kash = (await specLines(orderId)).find((l) => l.name === 'Кашкорсе')!;
    expect(kash.qtySource).toBe('NOMENCLATURE');
    expect(kash.normUnit).toBe('м пог.');
    expect(Number(kash.qtyPerUnit)).toBeCloseTo(0.2, 4);
    // 20 м × 1.66 м × 220 г/м² / 1000 = 7.304 кг
    expect(Number(kash.totalQty)).toBeCloseTo(7.304, 3);
  });

  // ---------------------------------------------------------------------------
  // T1-8
  // ---------------------------------------------------------------------------

  /** Лекало со спецификацией: Кулирка (м пог., норма 1) + слот плотности в её ячейке. */
  async function createPatternWithDensitySlot(): Promise<string> {
    n += 1;
    const spec = await createSpecPattern(t, t.adminCookie, {
      name: `Худи T1-8 ${n}`,
      parameters: [
        {
          key: 'main_density',
          label: 'Плотность',
          inputType: 'ENUM',
          options: ['180', '220'],
          unit: 'г/м²',
          isRequired: false,
          defaultValue: '180',
        },
      ],
      materialLines: [
        {
          name: 'Кулирка',
          unit: 'м пог.',
          qtyPerUnit: '1',
          materialRole: 'MAIN_FABRIC',
          fabricType: 'Кулирка',
          colorRule: 'ORDER_COLOR',
          parameterBindings: { 'char:density': 'main_density' },
        },
      ],
    });
    return spec.id;
  }

  /** Заказ: items M=100, расцветки Белый M=60, Чёрный M=40. */
  async function createTwoColorwayOrder(patternItemId: string): Promise<{
    orderId: string;
    whiteId: string;
    blackId: string;
  }> {
    const r = await api()
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-09-13T00:00:00.000Z',
        clientId: seed.client.id,
        patternItemId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        variants: [
          { color: 'Белый', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 60 }] },
          { color: 'Чёрный', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }] },
        ],
      })
      .expect(201);
    const orderId = r.body.id as string;
    const variants = await t.prisma.orderVariant.findMany({ where: { orderId }, orderBy: { ordinal: 'asc' } });
    return {
      orderId,
      whiteId: variants.find((v) => v.color === 'Белый')!.id,
      blackId: variants.find((v) => v.color === 'Чёрный')!.id,
    };
  }

  function groupOf(variants: VariantDto[], variantId: string): VariantDto {
    const g = variants.find((v) => v.orderVariantId === variantId);
    if (!g) throw new Error(`группа ${variantId} не найдена в DTO`);
    return g;
  }

  /**
   * Правки внутри заказа у Чёрного: плотность 220 (слот), норма 0.5 (ORDER),
   * цвет «графит» (FIXED_COLOR), ручная строка «Лента».
   */
  async function prepareBlackEdits(orderId: string, blackId: string): Promise<string> {
    const before = await techCard(orderId);
    const blackG = groupOf(before, blackId);
    const blackLine = blackG.lines.find((l) => !l.isManual)!;
    expect(blackLine.qtySource).toBe('TEMPLATE');
    expect(blackLine.densityGsm).toBe(180);

    const densityParam = blackG.parameters.find((p) => p.key === 'main_density')!;
    await api()
      .patch(`/api/orders/${orderId}/tech-card-parameters/${densityParam.id}`)
      .set('Cookie', t.adminCookie)
      .send({ value: '220' })
      .expect(200);
    await api()
      .patch(`/api/orders/${orderId}/tech-card/lines/${blackLine.id}`)
      .set('Cookie', t.adminCookie)
      .send({ qtyPerUnit: '0.5', colorText: 'графит' })
      .expect(200);
    await api()
      .post(`/api/orders/${orderId}/tech-card/lines`)
      .set('Cookie', t.adminCookie)
      .send({ orderVariantId: blackId, name: 'Лента', unit: 'м', qtyPerUnit: '0.9' })
      .expect(201);

    const edited = await t.prisma.orderMaterialRequirement.findUniqueOrThrow({ where: { id: blackLine.id } });
    expect(edited.qtyPerUnit.toString()).toBe('0.5');
    expect(edited.qtySource).toBe('ORDER');
    expect(edited.totalQty.toString()).toBe('20');
    expect(edited.colorRule).toBe('FIXED_COLOR');
    expect(edited.resolvedColorText).toBe('графит');
    expect(edited.densityGsm).toBe(220);
    return blackLine.id;
  }

  async function patchBlackColorway(orderId: string, variantId: string, sizes: Array<{ sizeId: string; qtyPlan: number }>) {
    return api()
      .patch(`/api/orders/${orderId}/colorways/${variantId}`)
      .set('Cookie', t.adminCookie)
      .send({ color: 'Чёрный', sizes })
      .expect(200);
  }

  async function snapshotCounts(orderId: string, blackId: string, whiteId: string) {
    const [blackTpl, blackManual, whiteTpl, blackParams, items] = await Promise.all([
      t.prisma.orderMaterialRequirement.count({ where: { orderId, orderVariantId: blackId, isManual: false } }),
      t.prisma.orderMaterialRequirement.count({ where: { orderId, orderVariantId: blackId, isManual: true } }),
      t.prisma.orderMaterialRequirement.count({ where: { orderId, orderVariantId: whiteId, isManual: false } }),
      t.prisma.orderTechCardParameter.count({ where: { orderId, orderVariantId: blackId } }),
      t.prisma.orderItem.findMany({ where: { orderId }, select: { qtyPlan: true } }),
    ]);
    return { blackTpl, blackManual, whiteTpl, blackParams, itemsQty: items.map((i) => i.qtyPlan) };
  }

  test('T1-8: обнуление тиража расцветки не сносит её строки и слоты; правки переживают цикл 40→0→40', async () => {
    const patternId = await createPatternWithDensitySlot();
    const { orderId, whiteId, blackId } = await createTwoColorwayOrder(patternId);
    const blackLineId = await prepareBlackEdits(orderId, blackId);

    const c0 = await snapshotCounts(orderId, blackId, whiteId);
    expect(c0).toMatchObject({ blackTpl: 1, blackManual: 1, whiteTpl: 1, blackParams: 1 });

    // Тираж Чёрного → 0 (sizes: []). Расцветка жива — её строки и слот тоже.
    await patchBlackColorway(orderId, blackId, []);
    const c1 = await snapshotCounts(orderId, blackId, whiteId);
    expect(c1).toMatchObject({ blackTpl: 1, blackManual: 1, whiteTpl: 1, blackParams: 1 });
    expect(c1.itemsQty).toEqual([60]);
    const zeroed = await t.prisma.orderMaterialRequirement.findUniqueOrThrow({ where: { id: blackLineId } });
    // Тираж строк нулевой группы обязан стать нулём (расчёт потребности читает
    // `totalQty` снимка как есть), норма/метка/цвет — на месте.
    expect(zeroed.totalQty.toString()).toBe('0');
    expect(zeroed.qtyPerUnit.toString()).toBe('0.5');
    expect(zeroed.qtySource).toBe('ORDER');
    expect(zeroed.resolvedColorText).toBe('графит');
    expect(zeroed.densityGsm).toBe(220);
    const whiteAfterZero = await t.prisma.orderMaterialRequirement.findFirstOrThrow({
      where: { orderId, orderVariantId: whiteId, isManual: false },
    });
    expect(whiteAfterZero.totalQty.toString()).toBe('60');

    // Тираж Чёрного обратно M=40: та же строка, те же правки, плотность своя.
    await patchBlackColorway(orderId, blackId, [{ sizeId: seed.sizes.M, qtyPlan: 40 }]);
    const after = await techCard(orderId);
    const blackG = groupOf(after, blackId);
    const line = blackG.lines.find((l) => !l.isManual)!;
    const densityParam = blackG.parameters.find((p) => p.key === 'main_density')!;
    expect(line.id).toBe(blackLineId);
    expect(line.qtyPerUnit).toBe('0.5');
    expect(line.qtySource).toBe('ORDER');
    expect(line.totalQty).toBe('20');
    expect(line.colorText).toBe('графит');
    expect(densityParam.value).toBe('220');
    expect(line.densityGsm).toBe(220);
    // Ручная строка Чёрного пересчитана по вернувшемуся тиражу.
    const manual = blackG.lines.find((l) => l.isManual)!;
    expect(manual.totalQty).toBe('36');
    // Белый не тронут.
    const whiteG = groupOf(after, whiteId);
    expect(whiteG.lines.find((l) => !l.isManual)!.totalQty).toBe('60');
    expect(whiteG.parameters.find((p) => p.key === 'main_density')!.value).toBe('180');
  });

  test('T1-8: sizes:[{M, qtyPlan:0}] — тот же путь, строки и слот Чёрного на месте', async () => {
    const patternId = await createPatternWithDensitySlot();
    const { orderId, whiteId, blackId } = await createTwoColorwayOrder(patternId);
    const blackLineId = await prepareBlackEdits(orderId, blackId);

    await patchBlackColorway(orderId, blackId, [{ sizeId: seed.sizes.M, qtyPlan: 0 }]);
    expect(await t.prisma.orderVariantSize.count({ where: { variantId: blackId } })).toBe(0);
    const c1 = await snapshotCounts(orderId, blackId, whiteId);
    expect(c1).toMatchObject({ blackTpl: 1, blackManual: 1, whiteTpl: 1, blackParams: 1 });
    const row = await t.prisma.orderMaterialRequirement.findUniqueOrThrow({ where: { id: blackLineId } });
    expect(row.totalQty.toString()).toBe('0');
    expect(row.qtySource).toBe('ORDER');
  });
});
