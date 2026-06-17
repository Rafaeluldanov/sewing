/**
 * Юнит-тесты «группа → параметр (подтип)» — связь каталога подтипов
 * (`MATERIAL_SUBTYPES`, таблица TEEON.pdf) с группами параметров
 * категории (`PATTERN_CATEGORY_PARAMETER_GROUPS`) и Zod-валидацией
 * `subtypeKey` (см. `packages/shared/src/material-characteristics.ts`,
 * `packages/shared/src/pattern-categories.ts`).
 */
import { describe, expect, test } from 'vitest';

import {
  MATERIAL_SUBTYPES,
  getMaterialSubtypesByGroup,
} from '@sewing/shared/material-characteristics';
import {
  PatternCategoryParameterInputSchema,
  getPatternCategoryParameterGroupConfig,
} from '@sewing/shared/pattern-categories';

describe('каталог подтипов согласован с группами параметров', () => {
  test('у каждого подтипа defaultInputType входит в allowedInputTypes своей группы', () => {
    for (const s of MATERIAL_SUBTYPES) {
      const group = getPatternCategoryParameterGroupConfig(s.groupRoleKey);
      expect(group, `группа ${s.groupRoleKey} для ${s.subtypeKey}`).not.toBeNull();
      expect(
        (group!.allowedInputTypes as readonly string[]).includes(
          s.defaultInputType,
        ),
        `${s.subtypeKey}: ${s.defaultInputType} ∉ allowedInputTypes(${s.groupRoleKey})`,
      ).toBe(true);
    }
  });

  test('у каждого подтипа defaultUnit входит в allowedUnits своей группы', () => {
    for (const s of MATERIAL_SUBTYPES) {
      const group = getPatternCategoryParameterGroupConfig(s.groupRoleKey)!;
      expect(
        (group.allowedUnits as readonly string[]).includes(s.defaultUnit),
        `${s.subtypeKey}: ${s.defaultUnit} ∉ allowedUnits(${s.groupRoleKey})`,
      ).toBe(true);
    }
  });

  test('синтепон — наполнитель, вводится «по размерам» (LINEAR_M_BY_SIZE), пух — нормой (QTY_PER_ITEM)', () => {
    const sintepon = MATERIAL_SUBTYPES.find((s) => s.subtypeKey === 'SINTEPON')!;
    expect(sintepon.groupRoleKey).toBe('FILLER');
    expect(sintepon.defaultInputType).toBe('LINEAR_M_BY_SIZE');
    const down = MATERIAL_SUBTYPES.find(
      (s) => s.subtypeKey === 'ARTIFICIAL_DOWN',
    )!;
    expect(down.defaultInputType).toBe('QTY_PER_ITEM');
  });

  test('getMaterialSubtypesByGroup(FILLER) = [Синтепон, Искусственный пух]', () => {
    const labels = getMaterialSubtypesByGroup('FILLER').map((s) => s.label);
    expect(labels).toEqual(['Синтепон', 'Искусственный пух']);
  });
});

describe('Zod: subtypeKey валидируется против группы', () => {
  const base = {
    roleKey: 'FILLER',
    label: 'Синтепон',
    inputType: 'LINEAR_M_BY_SIZE' as const,
    unit: 'м пог.',
  };

  test('валидный подтип своей группы — проходит', () => {
    const r = PatternCategoryParameterInputSchema.safeParse({
      ...base,
      subtypeKey: 'SINTEPON',
    });
    expect(r.success).toBe(true);
  });

  test('подтип чужой группы — ошибка', () => {
    const r = PatternCategoryParameterInputSchema.safeParse({
      ...base,
      roleKey: 'PACKAGING',
      label: 'Синтепон',
      inputType: 'QTY_PER_ITEM',
      unit: 'шт',
      subtypeKey: 'SINTEPON',
    });
    expect(r.success).toBe(false);
  });

  test('неизвестный подтип — ошибка', () => {
    const r = PatternCategoryParameterInputSchema.safeParse({
      ...base,
      subtypeKey: 'NOPE_X',
    });
    expect(r.success).toBe(false);
  });

  test('без subtypeKey / null («Другое») — проходит', () => {
    expect(
      PatternCategoryParameterInputSchema.safeParse(base).success,
    ).toBe(true);
    expect(
      PatternCategoryParameterInputSchema.safeParse({
        ...base,
        subtypeKey: null,
      }).success,
    ).toBe(true);
  });
});
