/**
 * Юнит-тесты подстановки параметров техкарты в ячейки строки материала
 * (`packages/shared/src/tech-card-parameters.ts`).
 *
 * Главное, что здесь проверяется, — ЗЕРКАЛО `characteristics` ↔ legacy-колонки.
 * Downstream (`WorkshopNeedsService`, cut-readiness, себестоимость) читает
 * СТАРЫЕ колонки `densityGsm`/`plannedWidthCm`/`hardware*`, а не JSON. Параметр,
 * записавший только JSON, был бы красиво виден в интерфейсе и НЕ повлиял бы на
 * расчёт закупки — самый дорогой промах в этой фиче.
 */
import { describe, expect, test } from 'vitest';

import {
  TECH_CARD_PARAMETER_TARGETS,
  TechCardParameterBindingsSchema,
  TechCardParameterInputSchema,
  applyParametersToCells,
  collectBoundParameterKeys,
  getTechCardParameterTarget,
  normalizeMaterialLineCells,
  type MaterialLineCells,
  type TechCardParameterValue,
} from '@sewing/shared/tech-card-parameters';

/** Строка полотна: плотность вынесена в параметр `main_density`. */
function fabricLine(overrides: Partial<MaterialLineCells> = {}): MaterialLineCells {
  return {
    name: 'Полотно основное',
    unit: 'м2',
    qtyPerUnit: '0.42',
    note: null,
    materialRole: 'MAIN_FABRIC',
    fabricType: 'кулирка',
    densityGsm: null,
    plannedWidthCm: null,
    hardwareSizeText: null,
    hardwareMaterialText: null,
    characteristics: null,
    ...overrides,
  };
}

function values(
  ...list: Array<Partial<TechCardParameterValue> & { key: string }>
): Map<string, TechCardParameterValue> {
  const m = new Map<string, TechCardParameterValue>();
  for (const v of list) {
    m.set(v.key, {
      value: null,
      isRequired: true,
      inputType: 'TEXT',
      ...v,
    });
  }
  return m;
}

describe('подстановка параметра доезжает до legacy-колонки', () => {
  test('char:density → и characteristics.density, и densityGsm', () => {
    const { cells, missingRequiredKeys } = applyParametersToCells(
      fabricLine(),
      { 'char:density': 'main_density' },
      values({ key: 'main_density', value: '190', inputType: 'NUMBER' }),
    );

    // Именно это читает WorkshopNeedsService для ветки AREA_DENSITY.
    expect(cells.densityGsm).toBe(190);
    expect(cells.characteristics?.density).toBe(190);
    expect(missingRequiredKeys).toEqual([]);
  });

  test('char:rollWidth → plannedWidthCm', () => {
    const { cells } = applyParametersToCells(
      fabricLine(),
      { 'char:rollWidth': 'roll_width' },
      values({ key: 'roll_width', value: '180', inputType: 'NUMBER' }),
    );

    expect(cells.plannedWidthCm).toBe(180);
    expect(cells.characteristics?.rollWidth).toBe(180);
  });

  test('фурнитура: char:size / char:material → hardware-колонки', () => {
    const { cells } = applyParametersToCells(
      fabricLine({ materialRole: 'PACKAGING', name: 'Молния', fabricType: null }),
      { 'char:size': 'zip_size', 'char:material': 'zip_material' },
      values(
        { key: 'zip_size', value: '5' },
        { key: 'zip_material', value: 'металл' },
      ),
    );

    expect(cells.hardwareSizeText).toBe('5');
    expect(cells.hardwareMaterialText).toBe('металл');
    expect(cells.characteristics?.size).toBe('5');
    expect(cells.characteristics?.material).toBe('металл');
  });

  test('роль-зачистка переживает подстановку: плотность у PACKAGING не оседает', () => {
    // Инвариант БД (см. TechCardsService.materialLineCreateData): density
    // имеет смысл только для не-PACKAGING. Параметр не должен его обходить.
    const { cells } = applyParametersToCells(
      fabricLine({ materialRole: 'PACKAGING' }),
      { 'char:density': 'main_density' },
      values({ key: 'main_density', value: '190', inputType: 'NUMBER' }),
    );

    expect(cells.densityGsm).toBeNull();
    expect(cells.characteristics?.density).toBeUndefined();
  });
});

describe('базовые ячейки строки', () => {
  test('core:qtyPerUnit и core:fabricType подставляются', () => {
    const { cells } = applyParametersToCells(
      fabricLine(),
      { 'core:qtyPerUnit': 'norm', 'core:fabricType': 'composition' },
      values(
        { key: 'norm', value: '0.5', inputType: 'NUMBER' },
        { key: 'composition', value: '95/5 лайкра' },
      ),
    );

    expect(cells.qtyPerUnit).toBe('0.5');
    expect(cells.fabricType).toBe('95/5 лайкра');
  });

  test('цвет не является целевой ячейкой — им управляет colorRule', () => {
    // Два писателя в одну ячейку дали бы молчаливый баг, поэтому color
    // сознательно выведен из-под параметров.
    expect(getTechCardParameterTarget('core:color')).toBeNull();
    expect(getTechCardParameterTarget('char:color')).toBeNull();
    expect(
      TECH_CARD_PARAMETER_TARGETS.some((t) => /color/i.test(t.field)),
    ).toBe(false);
  });
});

describe('незаполненные и битые значения', () => {
  test('пустой параметр ОЧИЩАЕТ свою ячейку — иначе она тихо устареет', () => {
    // Ячейка принадлежит параметру. Сохрани мы прежние 160 — технолог стёр
    // плотность, а в закупку уехало бы старое число. Дефолт задаётся у
    // параметра (defaultValue), а не остатком в ячейке.
    const { cells, missingRequiredKeys } = applyParametersToCells(
      fabricLine({ densityGsm: 160, characteristics: { density: 160 } }),
      { 'char:density': 'main_density' },
      values({ key: 'main_density', value: '  ', isRequired: true, inputType: 'NUMBER' }),
    );

    expect(missingRequiredKeys).toEqual(['main_density']);
    expect(cells.densityGsm).toBeNull();
    expect(cells.characteristics?.density).toBeUndefined();
  });

  test('пустой НЕобязательный параметр не попадает в missing', () => {
    const { missingRequiredKeys } = applyParametersToCells(
      fabricLine(),
      { 'core:note': 'comment' },
      values({ key: 'comment', value: null, isRequired: false }),
    );

    expect(missingRequiredKeys).toEqual([]);
  });

  test('нечисловое значение в числовой ячейке не подставляется', () => {
    const { cells } = applyParametersToCells(
      fabricLine({ densityGsm: 160, characteristics: { density: 160 } }),
      { 'char:density': 'main_density' },
      values({ key: 'main_density', value: 'плотная', inputType: 'NUMBER' }),
    );

    expect(cells.densityGsm).toBe(160);
  });

  test('параметра нет среди значений → ячейка остаётся из шаблона', () => {
    const { cells, missingRequiredKeys } = applyParametersToCells(
      fabricLine({ densityGsm: 160, characteristics: { density: 160 } }),
      { 'char:density': 'ghost' },
      values(),
    );

    expect(cells.densityGsm).toBe(160);
    expect(missingRequiredKeys).toEqual([]);
  });

  test('строка без биндингов проходит нормализацию без изменений смысла', () => {
    const { cells } = applyParametersToCells(
      fabricLine({ densityGsm: 190 }),
      null,
      values(),
    );

    expect(cells.densityGsm).toBe(190);
    expect(cells.characteristics?.density).toBe(190);
  });
});

describe('нормализация ячеек', () => {
  test('legacy-колонка без characteristics восстанавливает JSON', () => {
    const cells = normalizeMaterialLineCells(
      fabricLine({ densityGsm: 190, plannedWidthCm: 180 }),
    );

    expect(cells.characteristics).toEqual({ density: 190, rollWidth: 180 });
  });

  test('характеристики без legacy-колонки (type/length) сохраняются как есть', () => {
    const cells = normalizeMaterialLineCells(
      fabricLine({ characteristics: { type: 'спираль', length: 60 } }),
    );

    expect(cells.characteristics).toEqual({ type: 'спираль', length: 60 });
  });
});

describe('контракты', () => {
  test('биндинг на неизвестную ячейку отклоняется', () => {
    expect(
      TechCardParameterBindingsSchema.safeParse({ 'char:density': 'main_density' })
        .success,
    ).toBe(true);
    expect(
      TechCardParameterBindingsSchema.safeParse({ 'char:unknown': 'x' }).success,
    ).toBe(false);
  });

  test('ключ параметра — lower_snake', () => {
    const ok = TechCardParameterInputSchema.safeParse({
      key: 'main_density',
      label: 'Плотность',
      inputType: 'NUMBER',
    });
    expect(ok.success).toBe(true);

    const bad = TechCardParameterInputSchema.safeParse({
      key: 'Main Density',
      label: 'Плотность',
    });
    expect(bad.success).toBe(false);
  });

  test('ENUM без вариантов отклоняется', () => {
    const r = TechCardParameterInputSchema.safeParse({
      key: 'density',
      label: 'Плотность',
      inputType: 'ENUM',
      options: [],
    });
    expect(r.success).toBe(false);
  });

  test('collectBoundParameterKeys схлопывает дубли', () => {
    expect(
      collectBoundParameterKeys({
        'char:density': 'main_density',
        'core:fabricType': 'main_density',
        'core:note': 'comment',
      }).sort(),
    ).toEqual(['comment', 'main_density']);
  });
});
