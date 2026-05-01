/**
 * Smoke-тесты для единой группировки операций и оборудования
 * по категориям (см. ТЗ «Сделать единую удобную группировку списков
 * операций и оборудования по категории»).
 *
 * Защищаем три инварианта:
 *
 *   1. shared-helper'ы — единственный источник истины. Лейблы и
 *      порядок групп заданы в `@sewing/shared/operations`; web НЕ
 *      должен дублировать словарь категорий локально.
 *   2. UI применяет группировку: страницы `/admin/operations` и
 *      `/admin/equipment`, формы шаблона маршрута и редакторы
 *      оборудования рендерят секции/optgroup'ы из shared-helper'ов.
 *   3. Backend остаётся additive: `EquipmentSummaryDto` отдаёт
 *      `operationCategories`, Prisma не меняется.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  OPERATION_CATEGORIES,
  OPERATION_CATEGORY_LABELS,
  OPERATION_CATEGORY_ORDER,
  getEquipmentCategories,
  getOperationCategoryLabel,
  getPrimaryEquipmentCategory,
  groupEquipmentByOperationCategory,
  groupOperationsByCategory,
  sortOperationCategories,
} from '@sewing/shared/operations';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('shared/operations — единый источник категорий', () => {
  test('OPERATION_CATEGORY_ORDER совпадает с OPERATION_CATEGORIES (канон)', () => {
    expect(OPERATION_CATEGORY_ORDER).toEqual([
      'CUTTING',
      'SEWING',
      'QC',
      'IRONING',
      'PACKING',
    ]);
    expect([...OPERATION_CATEGORIES]).toEqual([...OPERATION_CATEGORY_ORDER]);
  });

  test('OPERATION_CATEGORY_LABELS содержит человекочитаемые лейблы', () => {
    expect(OPERATION_CATEGORY_LABELS.CUTTING).toBe('Раскрой');
    expect(OPERATION_CATEGORY_LABELS.SEWING).toBe('Пошив');
    expect(OPERATION_CATEGORY_LABELS.QC).toBe('ОТК');
    expect(OPERATION_CATEGORY_LABELS.IRONING).toBe('ВТО');
    expect(OPERATION_CATEGORY_LABELS.PACKING).toBe('Упаковка');
  });

  test('getOperationCategoryLabel: unknown/null → «Без категории»', () => {
    expect(getOperationCategoryLabel('CUTTING')).toBe('Раскрой');
    expect(getOperationCategoryLabel('PACKING')).toBe('Упаковка');
    expect(getOperationCategoryLabel(null)).toBe('Без категории');
    expect(getOperationCategoryLabel(undefined)).toBe('Без категории');
    expect(getOperationCategoryLabel('')).toBe('Без категории');
    expect(getOperationCategoryLabel('SOMETHING_NEW')).toBe('Без категории');
  });

  test('sortOperationCategories выстраивает каноничный порядок, неизвестные — в хвост', () => {
    const result = sortOperationCategories([
      'PACKING',
      'CUTTING',
      'XXX',
      'QC',
      'SEWING',
      'IRONING',
    ]);
    expect(result).toEqual([
      'CUTTING',
      'SEWING',
      'QC',
      'IRONING',
      'PACKING',
      'XXX',
    ]);
  });
});

describe('shared/operations — groupOperationsByCategory', () => {
  test('группы возвращаются в каноничном порядке, пустые отбрасываются', () => {
    const ops = [
      { id: '1', name: 'Упаковка', category: 'PACKING' },
      { id: '2', name: 'Оверлок', category: 'SEWING' },
      { id: '3', name: 'Распошив', category: 'SEWING' },
      { id: '4', name: 'Крой', category: 'CUTTING' },
    ];
    const groups = groupOperationsByCategory(ops);
    expect(groups.map((g) => g.category)).toEqual([
      'CUTTING',
      'SEWING',
      'PACKING',
    ]);
    expect(groups[0]!.label).toBe('Раскрой');
    expect(groups[1]!.operations).toHaveLength(2);
    expect(groups[2]!.label).toBe('Упаковка');
  });

  test('unknown/null категория уходит в «Без категории» в конце', () => {
    const ops = [
      { id: '1', name: 'Без', category: null },
      { id: '2', name: 'Странная', category: 'OTHER_LEGACY' },
      { id: '3', name: 'Пошив', category: 'SEWING' },
    ];
    const groups = groupOperationsByCategory(ops);
    expect(groups[0]!.category).toBe('SEWING');
    expect(groups.at(-1)!.category).toBe('UNKNOWN');
    expect(groups.at(-1)!.label).toBe('Без категории');
    expect(groups.at(-1)!.operations).toHaveLength(2);
  });

  test('пустой вход → пустой массив', () => {
    expect(groupOperationsByCategory([])).toEqual([]);
  });
});

describe('shared/operations — equipment helpers', () => {
  test('getPrimaryEquipmentCategory возвращает первую по канону', () => {
    expect(
      getPrimaryEquipmentCategory({
        id: 'eq1',
        name: 'Универсал',
        operations: [
          { category: 'PACKING' },
          { category: 'SEWING' },
          { category: 'CUTTING' },
        ],
      }),
    ).toBe('CUTTING');
    expect(
      getPrimaryEquipmentCategory({
        id: 'eq2',
        name: 'Без операций',
        operations: [],
      }),
    ).toBeNull();
    expect(
      getPrimaryEquipmentCategory({
        id: 'eq3',
        name: 'Только legacy',
        operations: [{ category: 'OLD' }],
      }),
    ).toBeNull();
  });

  test('getEquipmentCategories возвращает уникальные в каноничном порядке', () => {
    const cats = getEquipmentCategories({
      id: 'eq',
      name: 'x',
      operations: [
        { category: 'PACKING' },
        { category: 'SEWING' },
        { category: 'SEWING' },
        { category: 'CUTTING' },
        { category: 'OLD_LEGACY' },
      ],
    });
    expect(cats).toEqual(['CUTTING', 'SEWING', 'PACKING']);
  });

  test('groupEquipmentByOperationCategory: оборудование не дублируется', () => {
    const groups = groupEquipmentByOperationCategory([
      {
        id: 'eq1',
        name: 'Универсальный',
        operations: [{ category: 'SEWING' }, { category: 'IRONING' }],
      },
      {
        id: 'eq2',
        name: 'Только пошив',
        operations: [{ category: 'SEWING' }],
      },
      {
        id: 'eq3',
        name: 'Стол',
        operations: [],
      },
    ]);
    expect(groups.map((g) => g.category)).toEqual(['SEWING', 'UNKNOWN']);
    expect(groups[0]!.equipment).toHaveLength(2);
    expect(groups[1]!.label).toBe('Без операций');
    expect(groups[1]!.equipment).toHaveLength(1);
    // Универсальный встречается ровно один раз — в primary-группе SEWING
    // (т.к. SEWING < IRONING по `OPERATION_CATEGORY_ORDER`).
    const all = groups.flatMap((g) => g.equipment.map((eq) => eq.id));
    expect(all.filter((id) => id === 'eq1')).toHaveLength(1);
  });
});

describe('UI: /admin/operations — compact grouped table', () => {
  test('страница использует groupOperationsByCategory и единую compact таблицу', () => {
    const src = readSrc('apps/web/app/admin/operations/page.tsx');
    expect(src).toMatch(/groupOperationsByCategory/);
    // Compact layout (см. ТЗ «compact grouped-table layout»):
    // одна общая карточка + один table header, категории живут как
    // group-row внутри tbody. Старая «большая карточка на каждую
    // категорию» через `CategorySection` больше не используется на
    // этой странице.
    expect(src).toMatch(/admin-compact-grouped-card/);
    expect(src).toMatch(/admin-compact-grouped-table/);
    expect(src).toMatch(/admin-compact-group-row/);
    expect(src).not.toMatch(/CategorySection/);
    // Один thead на страницу — и ровно один <table> на компактной
    // карточке. Защищаем от регресса «вернули цикл по категориям».
    expect(src.match(/<thead>/g) ?? []).toHaveLength(1);
    expect(src.match(/<table\b/g) ?? []).toHaveLength(1);
    // Категории прокидываются в data-category — это нужно smoke-тестам
    // и e2e, чтобы выбирать конкретные группы без сравнения локализаций.
    expect(src).toMatch(/data-category=\{group\.category\}/);
    expect(src).toMatch(/data-category-title=\{group\.category\}/);
    // Локального дубля лейблов категорий быть не должно — только
    // shared-helper'ы.
    expect(src).not.toMatch(/CATEGORY_LABEL\b/);
  });
});

describe('UI: /admin/equipment — compact grouped table + chips', () => {
  test('страница использует groupEquipmentByOperationCategory и единую compact таблицу', () => {
    const src = readSrc('apps/web/app/admin/equipment/page.tsx');
    expect(src).toMatch(/groupEquipmentByOperationCategory/);
    // Compact layout: одна общая карточка + один table header.
    expect(src).toMatch(/admin-compact-grouped-card/);
    expect(src).toMatch(/admin-compact-grouped-table/);
    expect(src).toMatch(/admin-compact-group-row/);
    expect(src).not.toMatch(/CategorySection/);
    expect(src.match(/<thead>/g) ?? []).toHaveLength(1);
    expect(src.match(/<table\b/g) ?? []).toHaveLength(1);
    // Все категории показываем chip-списком, оборудование с
    // несколькими категориями НЕ дублируется по группам — за это
    // отвечает shared-helper, в UI достаточно проверить chip-классы
    // и data-атрибут.
    expect(src).toMatch(/admin-equipment-category-chips/);
    expect(src).toMatch(/admin-equipment-category-chip\b/);
    expect(src).toMatch(/data-category-chip/);
    expect(src).toMatch(/data-category=\{group\.category\}/);
    // Лейблы категорий — через shared helper, не через локальный словарь.
    expect(src).toMatch(/getOperationCategoryLabel/);
    expect(src).not.toMatch(/CATEGORY_LABEL\b/);
    // Empty state «Без операций» — это label из shared-helper для
    // `groupEquipmentByOperationCategory(UNKNOWN)`. Защищаем источник
    // истины, чтобы при будущей правке UI не отвалилось «Без операций».
    const sharedSrc = readSrc('packages/shared/src/operations.ts');
    expect(sharedSrc).toMatch(/'Без операций'/);
  });
});

describe('UI: route-template-form — pool по категориям', () => {
  test('пул «Добавить операции» использует группировку', () => {
    const src = readSrc('apps/web/app/admin/routes/route-template-form.tsx');
    expect(src).toMatch(/groupOperationsByCategory/);
    expect(src).toMatch(/availableGroups/);
  });
});

describe('UI: equipment forms — grouped operation select', () => {
  test('create-form использует GroupedOperationSelect', () => {
    const src = readSrc('apps/web/app/admin/equipment/create-form.tsx');
    expect(src).toMatch(/GroupedOperationSelect/);
  });

  test('edit-form (operations editor) использует GroupedOperationSelect', () => {
    const src = readSrc('apps/web/app/admin/equipment/[id]/edit-form.tsx');
    expect(src).toMatch(/GroupedOperationSelect/);
  });
});

describe('UI: operations forms — shared category labels', () => {
  test('create-form читает OPERATION_CATEGORY_LABELS из shared', () => {
    const src = readSrc('apps/web/app/admin/operations/create-form.tsx');
    expect(src).toMatch(/OPERATION_CATEGORY_LABELS/);
    expect(src).not.toMatch(/CATEGORY_LABEL\b/);
  });

  test('edit-form читает OPERATION_CATEGORY_LABELS из shared', () => {
    const src = readSrc('apps/web/app/admin/operations/[id]/edit-form.tsx');
    expect(src).toMatch(/OPERATION_CATEGORY_LABELS/);
    expect(src).not.toMatch(/CATEGORY_LABEL\b/);
  });
});

describe('UI: shared компоненты группировки', () => {
  test('GroupedOperationSelect и GroupedEquipmentSelect существуют и реэкспортированы', () => {
    const opSrc = readSrc(
      'apps/web/components/admin/grouped-operation-select.tsx',
    );
    expect(opSrc).toMatch(/groupOperationsByCategory/);
    expect(opSrc).toMatch(/<optgroup/);

    const eqSrc = readSrc(
      'apps/web/components/admin/grouped-equipment-select.tsx',
    );
    expect(eqSrc).toMatch(/groupEquipmentByOperationCategory/);
    expect(eqSrc).toMatch(/<optgroup/);

    const barrel = readSrc('apps/web/components/admin/index.ts');
    expect(barrel).toMatch(/GroupedOperationSelect/);
    expect(barrel).toMatch(/GroupedEquipmentSelect/);
    expect(barrel).toMatch(/CategorySection/);
  });

  test('admin-labels.ts использует shared getOperationCategoryLabel и не дублирует словарь', () => {
    const src = readSrc('apps/web/lib/admin-labels.ts');
    expect(src).toMatch(/getOperationCategoryLabel/);
    // Локальный CATEGORY_LABELS-словарь должен быть удалён.
    expect(src).not.toMatch(
      /OPERATION_CATEGORY_LABELS\s*:\s*Record<OperationCategory/,
    );
  });
});

describe('UI: /work — старая форма shift-start использует optgroup', () => {
  test('shift-start-form применяет groupOperationsByCategory', () => {
    const src = readSrc('apps/web/app/work/shift-start-form.tsx');
    expect(src).toMatch(/groupOperationsByCategory/);
    expect(src).toMatch(/<optgroup/);
  });
});

describe('Backend: EquipmentSummaryDto.operationCategories (additive)', () => {
  test('shared контракт содержит operationCategories', () => {
    const src = readSrc('packages/shared/src/equipment.ts');
    expect(src).toMatch(/operationCategories\s*:\s*string\[\]/);
  });

  test('EquipmentService.list заполняет operationCategories', () => {
    const src = readSrc('apps/api/src/modules/equipment/equipment.service.ts');
    expect(src).toMatch(/operationCategories:\s*this\.collectCategories/);
    expect(src).toMatch(/collectCategories/);
    // Используем существующий enum из shared — никакой новой Prisma-таблицы.
    expect(src).toMatch(/OPERATION_CATEGORY_ORDER/);
  });

  test('Prisma schema не менялась под эту задачу — никаких новых моделей', () => {
    const src = readSrc('prisma/schema.prisma');
    // Защита от случайного добавления отдельной таблицы категорий
    // («модель EquipmentCategory» / «model OperationCategory» не должно
    // появиться, источник — Operation.category).
    expect(src).not.toMatch(/model\s+EquipmentCategory\b/);
    expect(src).not.toMatch(/model\s+OperationCategory\b/);
  });
});
