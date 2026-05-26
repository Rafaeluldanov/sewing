import { expect, test } from 'vitest';

import { normalizeColor, normalizeColorOrNull } from '@sewing/shared/colors';
import {
  CreateOrderSchema,
  UpdateOrderSchema,
  UpdateOrderMaterialRequirementColorSchema,
} from '@sewing/shared/orders';
import { CreateCutReleasePolicySchema } from '@sewing/shared/cut-release-policy';

test('normalizeColor: trim + collapse whitespace + lower-case', () => {
  expect(normalizeColor('Белый')).toBe('белый');
  expect(normalizeColor('  Белый ')).toBe('белый');
  expect(normalizeColor('Чёрный')).toBe('чёрный');
  expect(normalizeColor('Серый\tМеланж')).toBe('серый меланж');
  expect(normalizeColor('графит  меланж')).toBe('графит меланж');
});

test('normalizeColor: ё сохраняется (не сводится к е)', () => {
  expect(normalizeColor('Чёрный')).not.toBe(normalizeColor('Черный'));
  expect(normalizeColor('Чёрный')).toBe('чёрный');
  expect(normalizeColor('Черный')).toBe('черный');
});

test('normalizeColorOrNull: null/undefined/пустая → null', () => {
  expect(normalizeColorOrNull(null)).toBeNull();
  expect(normalizeColorOrNull(undefined)).toBeNull();
  expect(normalizeColorOrNull('')).toBeNull();
  expect(normalizeColorOrNull('   ')).toBeNull();
  expect(normalizeColorOrNull('  Белый  ')).toBe('белый');
});

test('CreateOrderSchema.color нормализует значение', () => {
  // `CreateOrderSchema` обёрнут в `.superRefine`, поэтому `.shape`
  // напрямую недоступен — берём внутреннюю объектную схему.
  const inner = (CreateOrderSchema as unknown as {
    _def: { schema: { shape: { color: { parse: (v: unknown) => unknown } } } };
  })._def.schema;
  expect(inner.shape.color.parse('  Белый  ')).toBe('белый');
  expect(inner.shape.color.parse('Чёрный')).toBe('чёрный');
});

test('UpdateOrderSchema.color: пустая → null, регистр нормализуется', () => {
  const field = UpdateOrderSchema.shape.color;
  expect(field.parse('Белый')).toBe('белый');
  expect(field.parse('   ')).toBeNull();
  expect(field.parse(null)).toBeNull();
});

test('UpdateOrderMaterialRequirementColorSchema нормализует selectedColorText', () => {
  expect(
    UpdateOrderMaterialRequirementColorSchema.parse({
      selectedColorText: '  Графит-Меланж  ',
    }).selectedColorText,
  ).toBe('графит-меланж');
  expect(
    UpdateOrderMaterialRequirementColorSchema.parse({
      selectedColorText: '',
    }).selectedColorText,
  ).toBeNull();
});

test('CreateCutReleasePolicySchema нормализует color (фильтр политики)', () => {
  const parsed = CreateCutReleasePolicySchema.parse({
    limitQty: 50,
    color: '  Белый  ',
  });
  expect(parsed.color).toBe('белый');
});
