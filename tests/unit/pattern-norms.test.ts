/**
 * Юнит-тесты правила «норма расхода из номенклатуры → строка спецификации»
 * (`packages/shared/src/pattern-norms.ts`).
 *
 * Что здесь по-настоящему важно:
 *   1. ПАРНОСТЬ сопоставления. Обратное направление (строка → параметр) нельзя
 *      решать пер-строчно: у роли PACKAGING один источник «Молния» и три
 *      строки — наивный фолбэк «единственный кандидат по роли» отдал бы норму
 *      молнии шнуру и наконечнику. Это была бы тихая порча закупки.
 *   2. ЕДИНИЦЫ. Площадь (м²) не подставляется в строку, посчитанную в метрах:
 *      лучше оставить норму шаблона, чем показать бессмысленное число.
 *   3. СРЕДНЕВЗВЕШЕННАЯ по размерному плану, а не среднее арифметическое:
 *      тираж из 90 S и 10 XL обязан тянуть к норме S.
 */
import { describe, expect, test } from 'vitest';

import {
  derivePatternNormPerUnit,
  isNormUnitCompatible,
  matchPatternNormSources,
  type MaterialLineForMatch,
  type PatternNormSource,
} from '@sewing/shared/pattern-norms';

const zipperNorm: PatternNormSource = {
  sourceId: 'norm-zipper',
  kind: 'QTY_PER_ITEM',
  roleKey: 'PACKAGING',
  label: 'Молния',
  unit: 'шт',
  qtyPerItem: 1,
};

const cordLinear: PatternNormSource = {
  sourceId: 'param-cord',
  kind: 'LINEAR_M_BY_SIZE',
  roleKey: 'PACKAGING',
  label: 'Шнур',
  unit: 'м пог.',
  bySize: [
    { sizeId: 's', value: 1.1 },
    { sizeId: 'm', value: 1.2 },
    { sizeId: 'l', value: 1.35 },
  ],
};

/**
 * Как норма полотна заведена в боевой номенклатуре: поразмерные значения, но
 * единица — «кг». Именно эта пара («кг» у источника, «кг» у строки) раньше
 * отсекалась правилом «строка должна быть в метрах».
 */
const fabricLinearKg: PatternNormSource = {
  sourceId: 'param-kashkorse',
  kind: 'LINEAR_M_BY_SIZE',
  roleKey: 'RIB',
  label: 'Кашкорсе',
  unit: 'кг',
  bySize: [
    { sizeId: 's', value: 0.03 },
    { sizeId: 'm', value: 0.04 },
    { sizeId: 'l', value: 0.05 },
  ],
};

const fabricArea: PatternNormSource = {
  sourceId: 'MAIN_FABRIC',
  kind: 'AREA_M2_BY_SIZE',
  roleKey: 'MAIN_FABRIC',
  label: null,
  unit: 'м²',
  bySize: [
    { sizeId: 's', value: 0.4 },
    { sizeId: 'm', value: 0.42 },
    { sizeId: 'l', value: 0.45 },
  ],
};

function line(
  key: string,
  role: string,
  name: string,
  unit: string,
  fabricType: string | null = null,
): MaterialLineForMatch {
  return { key, materialRole: role, name, fabricType, unit };
}

describe('matchPatternNormSources', () => {
  test('точное совпадение имени параметра со строкой', () => {
    const lines = [
      line('l1', 'PACKAGING', 'Молния разъёмная', 'шт', 'Молния'),
      line('l2', 'PACKAGING', 'Шнур плоский', 'м', 'Шнур'),
    ];
    const map = matchPatternNormSources(lines, [zipperNorm, cordLinear]);
    expect(map.get('l1')?.sourceId).toBe('norm-zipper');
    expect(map.get('l2')?.sourceId).toBe('param-cord');
  });

  test('ё→е, регистр и лишние пробелы совпадению не мешают', () => {
    const map = matchPatternNormSources(
      [line('l1', 'PACKAGING', '  МОЛНИЯ  ', 'шт')],
      [{ ...zipperNorm, label: 'Мoлния'.replace('o', 'о') }],
    );
    expect(map.get('l1')?.sourceId).toBe('norm-zipper');
  });

  test('ГЛАВНОЕ: один источник и несколько строк роли — не угадываем', () => {
    const lines = [
      line('l1', 'PACKAGING', 'Молния', 'шт'),
      line('l2', 'PACKAGING', 'Наконечник', 'шт'),
      line('l3', 'PACKAGING', 'Кнопка', 'шт'),
    ];
    const map = matchPatternNormSources(lines, [zipperNorm]);
    // Совпало по имени только у «Молнии»; остальным чужую норму не отдаём.
    expect(map.get('l1')?.sourceId).toBe('norm-zipper');
    expect(map.has('l2')).toBe(false);
    expect(map.has('l3')).toBe(false);
  });

  test('имя параметра — начало названия строки («Молния» → «Молния разъёмная 60 см»)', () => {
    const lines = [
      line('l1', 'PACKAGING', 'Молния разъёмная 60 см', 'шт'),
      line('l2', 'PACKAGING', 'Наконечники для шнура', 'шт'),
      line('l3', 'PACKAGING', 'Шнур плоский 8 мм', 'м'), // единица не та
    ];
    const tips: PatternNormSource = {
      sourceId: 'norm-tips',
      kind: 'QTY_PER_ITEM',
      roleKey: 'PACKAGING',
      label: 'Наконечники',
      unit: 'шт',
      qtyPerItem: 2,
    };
    const cordQty: PatternNormSource = {
      sourceId: 'norm-cord',
      kind: 'QTY_PER_ITEM',
      roleKey: 'PACKAGING',
      label: 'Шнур',
      unit: 'шт',
      qtyPerItem: 1,
    };
    const map = matchPatternNormSources(lines, [zipperNorm, tips, cordQty]);
    expect(map.get('l1')?.sourceId).toBe('norm-zipper');
    expect(map.get('l2')?.qtyPerItem).toBe(2);
    // «Шнур» в штуках к строке в метрах не липнет.
    expect(map.has('l3')).toBe(false);
  });

  test('префикс подходит двум строкам — пару не берём', () => {
    const lines = [
      line('l1', 'PACKAGING', 'Молния разъёмная', 'шт'),
      line('l2', 'PACKAGING', 'Молния потайная', 'шт'),
    ];
    expect(matchPatternNormSources(lines, [zipperNorm]).size).toBe(0);
  });

  test('префикс только по границе слова: «Шнур» ≠ «Шнурок»', () => {
    const map = matchPatternNormSources(
      [line('l1', 'PACKAGING', 'Шнурок декоративный', 'шт')],
      [
        {
          sourceId: 'norm-cord',
          kind: 'QTY_PER_ITEM',
          roleKey: 'PACKAGING',
          label: 'Шнур',
          unit: 'шт',
          qtyPerItem: 1,
        },
        // Второй источник той же роли — чтобы не сработал шаг «один к одному».
        zipperNorm,
      ],
    );
    expect(map.size).toBe(0);
  });

  test('без совпадения имён: ровно один источник ↔ ровно одна строка', () => {
    const map = matchPatternNormSources(
      [line('l1', 'MAIN_FABRIC', 'Кулирка', 'м2')],
      [fabricArea],
    );
    expect(map.get('l1')?.sourceId).toBe('MAIN_FABRIC');

    // Две строки той же роли — уже неоднозначно, не матчим.
    const ambiguous = matchPatternNormSources(
      [
        line('l1', 'MAIN_FABRIC', 'Кулирка', 'м2'),
        line('l2', 'MAIN_FABRIC', 'Интерлок', 'м2'),
      ],
      [fabricArea],
    );
    expect(ambiguous.size).toBe(0);
  });

  test('единица не подходит — источник не отдаём', () => {
    // Площадь (м²) в строку, посчитанную в метрах, не подставляется.
    const map = matchPatternNormSources(
      [line('l1', 'MAIN_FABRIC', 'Кулирка', 'м')],
      [fabricArea],
    );
    expect(map.size).toBe(0);
  });

  test('боевой случай: «Кашкорсе» в кг — имя совпало, но строка не метровая', () => {
    // Так заведён прод: параметр «Кашкорсе» с единицей потребности «кг» и
    // строка спецификации тоже в «кг». Имена совпадают точно, но число в
    // ячейках — метры, поэтому пару НЕ берём: иначе длина уедет в поле веса.
    // Чтобы норма сюда доехала, строку надо вести в «м пог.», а «кг» держать
    // отдельной единицей закупки.
    const kgLine = matchPatternNormSources(
      [line('l1', 'RIB', 'Кашкорсе', 'кг', 'Кашкорсе')],
      [fabricLinearKg],
    );
    expect(kgLine.size).toBe(0);

    // Та же строка, ведённая в метрах, норму получает.
    const mLine = matchPatternNormSources(
      [line('l1', 'RIB', 'Кашкорсе', 'м пог.', 'Кашкорсе')],
      [fabricLinearKg],
    );
    expect(mLine.get('l1')?.sourceId).toBe('param-kashkorse');
  });

  test('«м» и «м пог.» в одной роли — пара неоднозначна, не матчим', () => {
    // Канонизация свела оба написания к одной единице, поэтому обе строки
    // теперь кандидаты и шаг 3 честно отказывается выбирать. Раньше разное
    // написание случайно оставляло одного кандидата — это была не логика, а
    // совпадение, и полагаться на него нельзя.
    const cordQty: PatternNormSource = {
      sourceId: 'norm-cord',
      kind: 'QTY_PER_ITEM',
      roleKey: 'PACKAGING',
      label: 'Шнур',
      unit: 'м пог.',
      qtyPerItem: 1.2,
    };
    const map = matchPatternNormSources(
      [
        line('l1', 'PACKAGING', 'Тесьма отделочная', 'м пог.'),
        line('l2', 'PACKAGING', 'Кант', 'м'),
      ],
      [cordQty],
    );
    expect(map.size).toBe(0);
  });

  test('строка без роли источника не получает', () => {
    const map = matchPatternNormSources(
      [{ key: 'l1', materialRole: null, name: 'Молния', fabricType: null, unit: 'шт' }],
      [zipperNorm],
    );
    expect(map.size).toBe(0);
  });
});

describe('isNormUnitCompatible', () => {
  test('погонные метры принимают «м» и «м пог.»', () => {
    expect(isNormUnitCompatible('м', cordLinear)).toBe(true);
    expect(isNormUnitCompatible('м пог.', cordLinear)).toBe(true);
    expect(isNormUnitCompatible('кг', cordLinear)).toBe(false);
  });

  test('площадь принимает только м²/м2', () => {
    expect(isNormUnitCompatible('м²', fabricArea)).toBe(true);
    expect(isNormUnitCompatible('м2', fabricArea)).toBe(true);
    expect(isNormUnitCompatible('м', fabricArea)).toBe(false);
  });

  test('штучная норма требует совпадения единиц', () => {
    expect(isNormUnitCompatible('шт', zipperNorm)).toBe(true);
    expect(isNormUnitCompatible('кат.', zipperNorm)).toBe(false);
    // Единица у источника не задана — не придираемся.
    expect(isNormUnitCompatible('шт', { ...zipperNorm, unit: null })).toBe(true);
  });

  // ГЛАВНОЕ ПРО ПОРАЗМЕРНЫЕ НОРМЫ. `unit` у них — единица ПОТРЕБНОСТИ (в чём
  // материал уйдёт в закупку), а в ячейках всегда погонные метры. Значит
  // единицу источника с единицей строки сравнивать нельзя: строка принимает
  // число как есть и обязана быть метровой.
  test('поразмерная норма с единицей потребности «кг» идёт в МЕТРОВУЮ строку', () => {
    expect(isNormUnitCompatible('м пог.', fabricLinearKg)).toBe(true);
    expect(isNormUnitCompatible('м', fabricLinearKg)).toBe(true);
  });

  test('поразмерная норма в строку в «кг» НЕ идёт, даже если у параметра «кг»', () => {
    // Иначе в килограммовое поле ляжет длина: на боевом заказе это давало
    // 808 вместо 343,8 кг. Перевод метров в вес требует ширины и плотности —
    // это работа расчёта потребности, а не спецификации.
    expect(isNormUnitCompatible('кг', fabricLinearKg)).toBe(false);
  });

  test('вид нормы решает, а не единица источника', () => {
    // Сторож против «сравним единицы у всех видов»: площадь с единицей
    // потребности «кг» в килограммовую строку не идёт, а поразмерная норма с
    // «м²» не идёт в строку в м² — там сырые метры, а не площадь.
    expect(isNormUnitCompatible('кг', { ...fabricArea, unit: 'кг' })).toBe(false);
    expect(
      isNormUnitCompatible('м2', { ...cordLinear, unit: 'м²' }),
    ).toBe(false);
  });

  test('у ШТУЧНОЙ нормы «м» и «м пог.» — одна единица', () => {
    // Здесь unit описывает само число, поэтому сравнение работает; канонизация
    // нужна, чтобы «Киперная лента, 0.35 м пог.» нашла строку в «м».
    expect(
      isNormUnitCompatible('м', { ...zipperNorm, unit: 'м пог.' }),
    ).toBe(true);
    expect(
      isNormUnitCompatible('м пог.', { ...zipperNorm, unit: 'м' }),
    ).toBe(true);
  });

  test('«кв.м» канонизируется в м²', () => {
    expect(isNormUnitCompatible('кв.м', fabricArea)).toBe(true);
    expect(isNormUnitCompatible('кв м', fabricArea)).toBe(true);
  });
});

describe('derivePatternNormPerUnit', () => {
  test('плоская норма отдаётся как есть', () => {
    expect(derivePatternNormPerUnit(zipperNorm, [])?.qtyPerUnit).toBe(1);
  });

  test('поразмерная норма — СРЕДНЕВЗВЕШЕННАЯ по плану', () => {
    const plan = [
      { sizeId: 's', qtyPlan: 90 },
      { sizeId: 'l', qtyPlan: 10 },
    ];
    const derived = derivePatternNormPerUnit(cordLinear, plan);
    // (1.1×90 + 1.35×10) / 100 = 1.125 — тянет к норме S, а не к среднему 1.225.
    expect(derived?.qtyPerUnit).toBe(1.125);
    expect(derived?.bySize.map((b) => b.sizeId)).toEqual(['s', 'l']);
  });

  test('размеры без значения в номенклатуре норму не занижают', () => {
    const plan = [
      { sizeId: 's', qtyPlan: 50 },
      { sizeId: 'xxl', qtyPlan: 50 }, // значения нет
    ];
    // Считаем только по покрытым размерам: 1.1, а не 0.55.
    expect(derivePatternNormPerUnit(cordLinear, plan)?.qtyPerUnit).toBe(1.1);
  });

  test('план пуст — среднее арифметическое по заполненным размерам', () => {
    const derived = derivePatternNormPerUnit(cordLinear, [
      { sizeId: 's', qtyPlan: 0 },
      { sizeId: 'm', qtyPlan: 0 },
    ]);
    expect(derived?.qtyPerUnit).toBe(1.15);
  });

  test('нет пересечения с планом — null (норма шаблона остаётся)', () => {
    expect(
      derivePatternNormPerUnit(cordLinear, [{ sizeId: 'xxl', qtyPlan: 10 }]),
    ).toBeNull();
    expect(
      derivePatternNormPerUnit({ ...zipperNorm, qtyPerItem: 0 }, []),
    ).toBeNull();
  });

  test('площадь считается тем же правилом', () => {
    const derived = derivePatternNormPerUnit(fabricArea, [
      { sizeId: 's', qtyPlan: 20 },
      { sizeId: 'm', qtyPlan: 30 },
    ]);
    // (0.4×20 + 0.42×30) / 50 = 0.412
    expect(derived?.qtyPerUnit).toBe(0.412);
  });
});
