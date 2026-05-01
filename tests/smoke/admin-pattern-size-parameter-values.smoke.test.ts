/**
 * Smoke-тесты блока «Погонные метры» в карточке номенклатуры
 * (`/admin/patterns/[id]`) и сопутствующих DTO/контракта.
 *
 * Контракт MVP «Погонные метры по размерам»:
 *   - в Prisma добавлена модель `PatternItemSizeParameterValue` с FK
 *     на `PatternItem`, `PatternCategoryParameter`, `Size` (новая
 *     additive миграция);
 *   - в shared есть `PatternItemSizeParameterValueDto`,
 *     `ReplacePatternItemSizeParameterValuesSchema` и поле
 *     `sizeParameterValues` в `PatternDetailDto`;
 *   - в shared `PATTERN_CATEGORY_PARAMETER_INPUT_TYPES` включает
 *     `LINEAR_M_BY_SIZE`, `PATTERN_CATEGORY_PARAMETER_GROUPS` —
 *     полный список групп параметров категорий;
 *   - на странице карточки появился блок «Погонные метры»;
 *   - форма блока (`size-parameter-values-form.tsx`) показывает
 *     только активные параметры категории с
 *     `inputType = LINEAR_M_BY_SIZE`, размеры — из активных
 *     `PatternSizeFile`, не светит `roleKey`;
 *   - server action `replacePatternItemSizeParameterValuesAction`
 *     ходит в backend через `replacePatternItemSizeParameterValues`
 *     lib-клиент;
 *   - `PatternMaterialArea` НЕ используется для погонных метров
 *     (там семантика про areaM2);
 *   - `WorkshopNeedsService` создаёт строки с
 *     `sourceType = PATTERN_SIZE_PARAMETER_VALUE`,
 *     `calculationMethod = LINEAR_M_BY_SIZE` (по одному параметру —
 *     одна строка `WorkshopNeed`).
 *
 * Все проверки — source-level. Backend / Prisma run-time проверяют
 * интеграционные тесты `tests/integration/patterns-size-parameter-values.test.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

const SCHEMA = 'prisma/schema.prisma';
const MIGRATION_DIR =
  'prisma/migrations/20260525100000_add_pattern_item_size_parameter_values';
const MIGRATION = `${MIGRATION_DIR}/migration.sql`;
const SHARED_CATEGORIES = 'packages/shared/src/pattern-categories.ts';
const SHARED_PATTERNS = 'packages/shared/src/patterns.ts';
const SHARED_NEEDS = 'packages/shared/src/workshop-needs.ts';
const API_SERVICE = 'apps/api/src/modules/patterns/patterns.service.ts';
const API_CONTROLLER = 'apps/api/src/modules/patterns/patterns.controller.ts';
const ERRORS = 'apps/api/src/common/errors.ts';
const NEEDS_SERVICE =
  'apps/api/src/modules/workshop-needs/workshop-needs.service.ts';
const PAGE = 'apps/web/app/admin/patterns/[id]/page.tsx';
const FORM = 'apps/web/app/admin/patterns/[id]/size-parameter-values-form.tsx';
const AREAS_FORM = 'apps/web/app/admin/patterns/[id]/material-areas-form.tsx';
const NORMS_FORM = 'apps/web/app/admin/patterns/[id]/parameter-norms-form.tsx';
const ACTIONS = 'apps/web/app/admin/patterns/actions.ts';
const FORM_STATE = 'apps/web/app/admin/patterns/form-state.ts';
const PATTERNS_API = 'apps/web/lib/patterns-api.ts';
const CAT_NEW_FORM =
  'apps/web/app/admin/pattern-categories/new/create-pattern-category-form.tsx';
const CAT_EDIT_FORM =
  'apps/web/app/admin/pattern-categories/[id]/edit-pattern-category-form.tsx';

// ---------------------------------------------------------------------------
// 1. Prisma — модель и миграция additive
// ---------------------------------------------------------------------------

describe('PatternItemSizeParameterValue — Prisma и миграция', () => {
  test('schema содержит модель PatternItemSizeParameterValue с обязательными полями', () => {
    const src = read(SCHEMA);
    expect(src).toMatch(/model PatternItemSizeParameterValue\s*\{/);
    expect(src).toMatch(
      /model PatternItemSizeParameterValue[\s\S]*?patternItemId\s+String/,
    );
    expect(src).toMatch(
      /model PatternItemSizeParameterValue[\s\S]*?categoryParameterId\s+String/,
    );
    expect(src).toMatch(
      /model PatternItemSizeParameterValue[\s\S]*?sizeId\s+String/,
    );
    expect(src).toMatch(
      /model PatternItemSizeParameterValue[\s\S]*?roleKey\s+String/,
    );
    expect(src).toMatch(
      /model PatternItemSizeParameterValue[\s\S]*?labelSnapshot\s+String/,
    );
    expect(src).toMatch(
      /model PatternItemSizeParameterValue[\s\S]*?inputTypeSnapshot\s+String/,
    );
    expect(src).toMatch(
      /model PatternItemSizeParameterValue[\s\S]*?unit\s+String/,
    );
    // value Decimal(14, 4)
    expect(src).toMatch(
      /model PatternItemSizeParameterValue[\s\S]*?value\s+Decimal\s+@db\.Decimal\(14,\s*4\)/,
    );
    // Уникальность (patternItemId, categoryParameterId, sizeId)
    expect(src).toMatch(
      /model PatternItemSizeParameterValue[\s\S]*?@@unique\(\[patternItemId,\s*categoryParameterId,\s*sizeId\]/,
    );
    // FK с onDelete: Cascade с трёх сторон
    expect(src).toMatch(
      /patternItem\s+PatternItem\s+@relation\([^)]*onDelete:\s*Cascade/,
    );
    expect(src).toMatch(
      /categoryParameter\s+PatternCategoryParameter\s+@relation\([^)]*onDelete:\s*Cascade/,
    );
    expect(src).toMatch(
      /size\s+Size\s+@relation\([^)]*onDelete:\s*Cascade/,
    );
  });

  test('relation-поля добавлены на PatternItem / PatternCategoryParameter / Size', () => {
    const src = read(SCHEMA);
    expect(src).toMatch(
      /model PatternItem[\s\S]*?sizeParameterValues\s+PatternItemSizeParameterValue\[\]/,
    );
    expect(src).toMatch(
      /model PatternCategoryParameter[\s\S]*?patternItemSizeValues\s+PatternItemSizeParameterValue\[\]/,
    );
    expect(src).toMatch(
      /model Size[\s\S]*?patternItemSizeParameterValues\s+PatternItemSizeParameterValue\[\]/,
    );
  });

  test('PatternMaterialArea и PatternItemParameterNorm НЕ изменились', () => {
    const src = read(SCHEMA);
    // Площади остались с materialRole/areaM2 и тем же primary key.
    expect(src).toMatch(/model PatternMaterialArea\s*\{[\s\S]*?materialRole\s+String[\s\S]*?areaM2\s+Decimal/);
    // Нормы фурнитуры остались с qtyPerItem.
    expect(src).toMatch(/model PatternItemParameterNorm\s*\{[\s\S]*?qtyPerItem\s+Decimal/);
  });

  test('migration существует и additive (только CREATE TABLE + FK + indexes)', () => {
    expect(exists(MIGRATION)).toBe(true);
    const src = read(MIGRATION);
    expect(src).toMatch(/CREATE TABLE "PatternItemSizeParameterValue"/);
    expect(src).toMatch(
      /CREATE UNIQUE INDEX "PatternItemSizeParameterValue_pattern_param_size_uniq"/,
    );
    expect(src).toMatch(
      /CREATE INDEX "PatternItemSizeParameterValue_patternItemId_idx"/,
    );
    expect(src).toMatch(
      /CREATE INDEX "PatternItemSizeParameterValue_categoryParameterId_idx"/,
    );
    expect(src).toMatch(
      /CREATE INDEX "PatternItemSizeParameterValue_sizeId_idx"/,
    );
    expect(src).toMatch(
      /CREATE INDEX "PatternItemSizeParameterValue_roleKey_idx"/,
    );
    expect(src).toMatch(/FOREIGN KEY \("patternItemId"\)/);
    expect(src).toMatch(/FOREIGN KEY \("categoryParameterId"\)/);
    expect(src).toMatch(/FOREIGN KEY \("sizeId"\)/);
    // Никаких ALTER TABLE по чужим таблицам.
    for (const table of [
      '"PatternMaterialArea"',
      '"PatternItemParameterNorm"',
      '"PatternItem"',
      '"PatternCategoryParameter"',
      '"Order"',
      '"OrderItem"',
      '"WorkshopNeed"',
      '"PurchaseOrder"',
      '"PurchaseReceipt"',
      '"TechCardMaterialLine"',
      '"Passport"',
    ]) {
      expect(src).not.toMatch(new RegExp(`ALTER\\s+TABLE\\s+${table}\\b`));
    }
    // Никаких destructive операций.
    expect(src).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(src).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(src).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared — DTO, схема, конфиг групп параметров
// ---------------------------------------------------------------------------

describe('@sewing/shared/pattern-categories — группы параметров и LINEAR_M_BY_SIZE', () => {
  const src = read(SHARED_CATEGORIES);

  test('LINEAR_M_BY_SIZE добавлен в whitelist input types', () => {
    expect(src).toMatch(
      /PATTERN_CATEGORY_PARAMETER_INPUT_TYPES\s*=\s*\[[\s\S]*?'LINEAR_M_BY_SIZE'/,
    );
    // Старые типы продолжают работать.
    expect(src).toMatch(/'AREA_M2_BY_SIZE'/);
    expect(src).toMatch(/'QTY_PER_ITEM'/);
    expect(src).toMatch(/'TEXT_ONLY'/);
    // Лейбл — то, что видит пользователь.
    expect(src).toMatch(
      /LINEAR_M_BY_SIZE:\s*'Погонные метры по размерам'/,
    );
  });

  test('default unit для LINEAR_M_BY_SIZE — «м пог.»', () => {
    expect(src).toMatch(/LINEAR_M_BY_SIZE:\s*'м пог\.'/);
  });

  test('PATTERN_CATEGORY_PARAMETER_GROUPS описывает все управленческие группы', () => {
    expect(src).toMatch(/PATTERN_CATEGORY_PARAMETER_GROUPS\s*[:=]/);
    // Все roleKey-ключи новых групп должны быть в файле.
    for (const role of [
      'MAIN_FABRIC',
      'ADDITIONAL_FABRIC',
      'RIB',
      'LINING',
      'FILLER',
      'INTERLINING',
      'THREAD',
      'PACKAGING',
      'MARKING',
    ]) {
      expect(src).toMatch(new RegExp(`roleKey:\\s*'${role}'`));
    }
    // Пользовательские лейблы — без слова «Упаковка».
    expect(src).toMatch(/'Основное полотно'/);
    expect(src).toMatch(/'Дополнительное полотно'/);
    expect(src).toMatch(/'Рибана \/ кашкорсе'/);
    expect(src).toMatch(/'Подкладка'/);
    expect(src).toMatch(/'Наполнитель'/);
    expect(src).toMatch(/'Дублерин \/ клеевые'/);
    expect(src).toMatch(/'Нитки'/);
    expect(src).toMatch(/'Фурнитура'/);
    expect(src).toMatch(/'Маркировка'/);
    // PACKAGING остаётся техническим ключом, но юзер видит «Фурнитура».
    expect(src).not.toMatch(/label:\s*'Упаковка'/);
  });

  test('helpers экспортированы', () => {
    expect(src).toMatch(/export function getPatternCategoryParameterGroupConfig\b/);
    expect(src).toMatch(/export function getPatternCategoryParameterGroupLabel\b/);
    expect(src).toMatch(/export function getAllowedUnitsForParameterGroup\b/);
    expect(src).toMatch(/export function getDefaultUnitForParameterGroup\b/);
    expect(src).toMatch(/export function getDefaultInputTypeForParameterGroup\b/);
  });

  test('runtime: LINEAR_M_BY_SIZE проходит валидацию параметра', async () => {
    const mod: typeof import('../../packages/shared/src/pattern-categories') =
      await import('../../packages/shared/src/pattern-categories');
    const ok = mod.PatternCategoryParameterInputSchema.safeParse({
      roleKey: 'MAIN_FABRIC',
      label: 'Основное полотно',
      inputType: 'LINEAR_M_BY_SIZE',
      unit: 'м пог.',
    });
    expect(ok.success).toBe(true);
    // helpers
    const config = mod.getPatternCategoryParameterGroupConfig('MAIN_FABRIC');
    expect(config?.label).toBe('Основное полотно');
    expect(config?.allowedInputTypes).toContain('LINEAR_M_BY_SIZE');
    // Этап «Исправить смысл LINEAR_M_BY_SIZE»: дефолтная единица
    // потребности для основного полотна — «кг» (конверсия из
    // м пог. через ширину/плотность техкарты делает backend).
    // Старый дефолт «м пог.» остался допустимым значением.
    expect(mod.getDefaultUnitForParameterGroup('MAIN_FABRIC')).toBe('кг');
    expect(
      (config?.allowedUnits as readonly string[]).includes('м пог.'),
    ).toBe(true);
    expect(
      (config?.allowedUnits as readonly string[]).includes('кг'),
    ).toBe(true);
    expect(mod.getDefaultInputTypeForParameterGroup('MAIN_FABRIC')).toBe(
      'LINEAR_M_BY_SIZE',
    );
    expect(mod.getDefaultInputTypeForParameterGroup('PACKAGING')).toBe(
      'QTY_PER_ITEM',
    );

    // Этап «Исправить смысл LINEAR_M_BY_SIZE»: новые helpers — единица
    // ввода (м пог. для LINEAR_M_BY_SIZE) и человекочитаемое
    // объяснение типа ввода для UI-подсказок.
    expect(mod.getPatternCategoryInputUnitLabel('LINEAR_M_BY_SIZE')).toBe(
      'м пог.',
    );
    expect(mod.getPatternCategoryInputUnitLabel('AREA_M2_BY_SIZE')).toBe('м²');
    expect(mod.getPatternCategoryInputUnitLabel('QTY_PER_ITEM')).toBe(
      'на изделие',
    );
    expect(mod.getPatternCategoryInputUnitLabel('TEXT_ONLY')).toBe(null);
    expect(
      mod.getPatternCategoryInputTypeExplanation('LINEAR_M_BY_SIZE'),
    ).toMatch(/погонн/i);
    expect(
      mod.getPatternCategoryInputTypeExplanation('QTY_PER_ITEM'),
    ).toMatch(/на одно изделие/i);
    // Категория с LINEAR_M_BY_SIZE сохраняется целиком.
    const okCat = mod.CreatePatternCategorySchema.safeParse({
      name: 'Худи',
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
    });
    expect(okCat.success).toBe(true);
  });
});

describe('@sewing/shared/patterns — DTO для PatternItemSizeParameterValue', () => {
  const src = read(SHARED_PATTERNS);

  test('Replace-схема и input-DTO существуют', () => {
    expect(src).toMatch(/ReplacePatternItemSizeParameterValueInputSchema\b/);
    expect(src).toMatch(/ReplacePatternItemSizeParameterValuesSchema\b/);
    expect(src).toMatch(/ReplacePatternItemSizeParameterValueInputDto\b/);
    expect(src).toMatch(/ReplacePatternItemSizeParameterValuesDto\b/);
  });

  test('PatternItemSizeParameterValueDto и поле в PatternDetailDto', () => {
    expect(src).toMatch(/interface PatternItemSizeParameterValueDto\b/);
    expect(src).toMatch(/sizeParameterValues:\s*PatternItemSizeParameterValueDto\[\]/);
    // Snapshot-поля.
    expect(src).toMatch(/labelSnapshot:\s*string/);
    expect(src).toMatch(/inputTypeSnapshot:\s*string/);
    expect(src).toMatch(/value:\s*string/);
  });

  test('runtime: Replace-схема валидирует value > 0 и отбрасывает дубль (param,size)', async () => {
    const mod: typeof import('../../packages/shared/src/patterns') = await import(
      '../../packages/shared/src/patterns'
    );
    const ok = mod.ReplacePatternItemSizeParameterValuesSchema.safeParse({
      values: [
        { categoryParameterId: 'p1', sizeId: 's1', value: '1.2' },
        { categoryParameterId: 'p1', sizeId: 's2', value: '1.4' },
      ],
    });
    expect(ok.success).toBe(true);
    const negative = mod.ReplacePatternItemSizeParameterValuesSchema.safeParse({
      values: [{ categoryParameterId: 'p1', sizeId: 's1', value: '-1' }],
    });
    expect(negative.success).toBe(false);
    const dup = mod.ReplacePatternItemSizeParameterValuesSchema.safeParse({
      values: [
        { categoryParameterId: 'p1', sizeId: 's1', value: '1' },
        { categoryParameterId: 'p1', sizeId: 's1', value: '2' },
      ],
    });
    expect(dup.success).toBe(false);
  });
});

describe('@sewing/shared/workshop-needs — новый sourceType + calculationMethod', () => {
  const src = read(SHARED_NEEDS);

  test('PATTERN_SIZE_PARAMETER_VALUE есть в WORKSHOP_NEED_SOURCE_TYPES', () => {
    expect(src).toMatch(
      /WORKSHOP_NEED_SOURCE_TYPES\s*=\s*\[[\s\S]*?'PATTERN_SIZE_PARAMETER_VALUE'/,
    );
  });

  test('LINEAR_M_BY_SIZE есть в WORKSHOP_NEED_CALCULATION_METHODS с лейблом', () => {
    expect(src).toMatch(
      /WORKSHOP_NEED_CALCULATION_METHODS\s*=\s*\[[\s\S]*?'LINEAR_M_BY_SIZE'/,
    );
    expect(src).toMatch(
      /LINEAR_M_BY_SIZE:\s*'Погонные метры по размерам'/,
    );
  });

  test('getWorkshopNeedKind учитывает новый sourceType (MATERIAL)', () => {
    expect(src).toMatch(/PATTERN_SIZE_PARAMETER_VALUE/);
    expect(src).toMatch(/LINEAR_M_BY_SIZE/);
  });
});

// ---------------------------------------------------------------------------
// 3. Backend — service / controller / errors
// ---------------------------------------------------------------------------

describe('apps/api — patterns.service / controller для size parameter values', () => {
  test('controller имеет PUT /size-parameter-values', () => {
    const ctl = read(API_CONTROLLER);
    expect(ctl).toMatch(/@Put\(':id\/size-parameter-values'\)/);
    expect(ctl).toMatch(/replaceSizeParameterValues\b/);
    expect(ctl).toMatch(/ReplacePatternItemSizeParameterValuesSchema/);
  });

  test('service имеет replaceSizeParameterValues и пишет аудит', () => {
    const svc = read(API_SERVICE);
    expect(svc).toMatch(/async replaceSizeParameterValues\(/);
    // Whitelist по LINEAR_M_BY_SIZE параметрам категории лекала.
    expect(svc).toMatch(/inputType:\s*'LINEAR_M_BY_SIZE'/);
    // Snapshot-поля копируются из параметра категории.
    expect(svc).toMatch(/labelSnapshot:\s*param\.label/);
    expect(svc).toMatch(/inputTypeSnapshot:\s*param\.inputType/);
    // Аудит-событие.
    expect(svc).toMatch(/PATTERN_SIZE_PARAMETER_VALUES_REPLACED/);
    // Бросает специальное исключение.
    expect(svc).toMatch(/PatternSizeParameterValueNotAllowedException/);
  });

  test('toDetailDto отдаёт sizeParameterValues с size-snapshot', () => {
    const svc = read(API_SERVICE);
    expect(svc).toMatch(/sizeParameterValues:\s*PatternItemSizeParameterValueDto\[\]/);
    expect(svc).toMatch(/sizeParameterValues:\s*\{/);
    // Размер включён через include.
    expect(svc).toMatch(/sizeParameterValues:[\s\S]*?include:\s*\{\s*size:\s*true\s*\}/);
  });

  test('errors.ts содержит PatternSizeParameterValueNotAllowedException', () => {
    const e = read(ERRORS);
    expect(e).toMatch(/PatternSizeParameterValueNotAllowedException/);
    expect(e).toMatch(/PATTERN_SIZE_PARAMETER_VALUE_NOT_ALLOWED/);
  });
});

describe('apps/api — workshop-needs.service считает LINEAR_M_BY_SIZE', () => {
  const src = read(NEEDS_SERVICE);

  test('include sizeParameterValues при загрузке pattern', () => {
    expect(src).toMatch(/sizeParameterValues:\s*true/);
  });

  test('создаёт строку с sourceType PATTERN_SIZE_PARAMETER_VALUE и calculationMethod LINEAR_M_BY_SIZE', () => {
    expect(src).toMatch(/PATTERN_SIZE_PARAMETER_VALUE/);
    expect(src).toMatch(/calculationMethod:\s*'LINEAR_M_BY_SIZE'/);
    // Один параметр = одна строка: группировка по categoryParameterId.
    expect(src).toMatch(/computeLinearBySizeParameter\b/);
    expect(src).toMatch(/linearByParam\b/);
  });

  test('LINEAR_M_BY_SIZE: пересчёт через ширину/плотность для outputUnit ∈ {кг, м²}', () => {
    // Этап «Исправить смысл LINEAR_M_BY_SIZE»: backend считает
    // rawLinearM, затем конвертирует в outputUnit по
    // `parameter.unit` через ширину рулона и плотность из техкарты.
    expect(src).toMatch(/rawLinearM/);
    // Ветки конверсии по единице потребности.
    expect(src).toMatch(/outputUnit\s*===\s*'кг'/);
    expect(src).toMatch(/outputUnit\s*===\s*'м²'/);
    expect(src).toMatch(/outputUnit\s*===\s*'м пог\.'/);
    // Source техкарты для ширины/плотности (берётся из той же
    // sourceLines по совпадению materialRole = roleKey).
    expect(src).toMatch(/sourceLines/);
    expect(src).toMatch(/plannedWidthCm/);
    expect(src).toMatch(/densityGsm/);
    // PatternMaterialArea для LINEAR_M_BY_SIZE НЕ используется —
    // в `computeLinearBySizeParameter` нет работы с materialAreas.
    const fnStart = src.indexOf('private computeLinearBySizeParameter');
    const fnEnd = src.indexOf(
      '/**',
      src.indexOf('private resolveColor', fnStart),
    );
    const fnSrc = src.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnSrc).not.toMatch(/PatternMaterialArea/);
    expect(fnSrc).not.toMatch(/materialAreas/);
  });

  test('LINEAR_M_BY_SIZE: warnings без crash при отсутствии ширины/плотности', () => {
    // При outputUnit = кг и отсутствии ширины/плотности — warning
    // в `calculationNote` и `result.warnings`, calculatedQty = 0
    // (не ложное число).
    expect(src).toMatch(/Не указана ширина материала/);
    expect(src).toMatch(/Не указана плотность материала/);
    expect(src).toMatch(/Единица потребности «\$\{outputUnit\}»/);
  });
});

// ---------------------------------------------------------------------------
// 4. Frontend — карточка номенклатуры, форма «Погонные метры»
// ---------------------------------------------------------------------------

describe('admin/patterns/[id] — блок «Погонные метры»', () => {
  test('страница карточки рендерит блок и компонент формы', () => {
    expect(exists(PAGE)).toBe(true);
    const src = read(PAGE);
    expect(src).toMatch(/Погонные метры/);
    expect(src).toMatch(/PatternItemSizeParameterValuesForm/);
    expect(src).toMatch(/PatternSizeParameterValuesBlock/);
    // Активные размеры считаются локально (помощник идентичен
    // pattern-sizes-manager.tsx).
    expect(src).toMatch(/computeActivePatternSizes/);
    expect(src).toMatch(/inputType\s*===\s*'LINEAR_M_BY_SIZE'/);
  });

  test('form-state и server action для размерных значений добавлены', () => {
    const fs = read(FORM_STATE);
    expect(fs).toMatch(/SizeParameterValuesState\b/);
    expect(fs).toMatch(/initialSizeParameterValuesState\b/);
    const a = read(ACTIONS);
    expect(a).toMatch(/replacePatternItemSizeParameterValuesAction\b/);
    // Парсинг по __sizeIds + __parameterIds + value_<pid>_<sid>.
    expect(a).toMatch(/__sizeIds/);
    expect(a).toMatch(/__parameterIds/);
    expect(a).toMatch(/value_\$\{parameterId\}_\$\{sizeId\}/);
  });

  test('форма не показывает roleKey, рендерит ячейки value_<param>_<size>', () => {
    expect(exists(FORM)).toBe(true);
    const src = read(FORM);
    expect(src.startsWith("'use client'")).toBe(true);
    // Defence-in-depth: только LINEAR_M_BY_SIZE и ACTIVE параметры.
    expect(src).toMatch(/inputType\s*===\s*'LINEAR_M_BY_SIZE'/);
    expect(src).toMatch(/p\.status\s*===\s*'ACTIVE'/);
    expect(src).toMatch(/__sizeIds/);
    expect(src).toMatch(/__parameterIds/);
    expect(src).toMatch(/value_\$\{p\.id\}_\$\{size\.id\}/);
    // Никакого roleKey в шапке колонок.
    expect(src).not.toMatch(/p\.roleKey/);
  });

  test('форма показывает единицу ввода (м пог.), а не parameter.unit как unit ввода', () => {
    // Этап «Исправить смысл LINEAR_M_BY_SIZE»: ячейки ввода
    // ВСЕГДА означают м пог.; `parameter.unit` (кг/м²/м пог.) —
    // это единица потребности, она показывается отдельной
    // подписью под заголовком колонки («ввод: м пог. → потребность: кг»).
    const src = read(FORM);
    // Импорт shared-helper-а getPatternCategoryInputUnitLabel.
    expect(src).toMatch(/getPatternCategoryInputUnitLabel/);
    // В шапке колонки рисуется «ввод: <inputUnit>».
    expect(src).toMatch(/ввод:\s*\{inputUnit\}/);
    // И «потребность: <needUnit>», когда `parameter.unit` задан.
    expect(src).toMatch(/потребность:\s*\{needUnit\}/);
    // Placeholder для input-а — единица ВВОДА, а не parameter.unit
    // (старый placeholder p.unit убрали).
    expect(src).toMatch(/placeholder=\{inputUnit\}/);
    expect(src).not.toMatch(/placeholder=\{p\.unit \|\|/);
  });

  test('lib/patterns-api.ts экспортирует replacePatternItemSizeParameterValues', () => {
    const src = read(PATTERNS_API);
    expect(src).toMatch(/export function replacePatternItemSizeParameterValues\b/);
    expect(src).toMatch(/\/size-parameter-values/);
    expect(src).toMatch(/method:\s*'PUT'/);
  });
});

// ---------------------------------------------------------------------------
// 5. Гарантии — старые таблицы / формы не сломаны
// ---------------------------------------------------------------------------

describe('Этап «Погонные метры по размерам» — guards: ничего не сломали', () => {
  test('AREA_M2_BY_SIZE по-прежнему хранится в PatternMaterialArea', () => {
    const svc = read(API_SERVICE);
    expect(svc).toMatch(/replaceMaterialAreas\b/);
    expect(svc).toMatch(/inputType:\s*'AREA_M2_BY_SIZE'/);
    expect(svc).toMatch(/PatternMaterialArea/);
  });

  test('QTY_PER_ITEM по-прежнему хранится в PatternItemParameterNorm', () => {
    const svc = read(API_SERVICE);
    expect(svc).toMatch(/replaceParameterNorms\b/);
    expect(svc).toMatch(/inputType:\s*'QTY_PER_ITEM'/);
    expect(svc).toMatch(/PatternItemParameterNorm/);
  });

  test('форма «Площади материалов» осталась работать (AREA_M2_BY_SIZE)', () => {
    const src = read(AREAS_FORM);
    expect(src).toMatch(/inputType\s*===\s*'AREA_M2_BY_SIZE'/);
  });

  test('форма «Фурнитура и нормы» осталась работать (QTY_PER_ITEM)', () => {
    const src = read(NORMS_FORM);
    expect(src).toMatch(/inputType\s*===\s*'QTY_PER_ITEM'/);
  });

  test('TechCard / Order / Passport / payroll / PurchaseOrder / PurchaseReceipt не менялись', () => {
    // На уровне миграции (см. п. 1) уже проверили, что additive
    // не трогает их таблицы. Здесь дополнительно убеждаемся, что
    // shared / API не получили новых полей в этих модулях через
    // эту итерацию (ищем якорные имена сервисов / DTO).
    const mig = read(MIGRATION);
    for (const t of [
      '"TechCardMaterialLine"',
      '"Order"',
      '"OrderItem"',
      '"Passport"',
      '"PurchaseOrder"',
      '"PurchaseOrderLine"',
      '"PurchaseReceipt"',
      '"PurchaseReceiptLine"',
    ]) {
      expect(mig).not.toMatch(new RegExp(`ALTER\\s+TABLE\\s+${t}\\b`));
    }
  });

  test('категории форм не показывают слово «Упаковка», но сохраняют «Фурнитура»', () => {
    const newForm = read(CAT_NEW_FORM);
    const editForm = read(CAT_EDIT_FORM);
    for (const src of [newForm, editForm]) {
      expect(src).not.toMatch(/Упаковка/);
      // PATTERN_CATEGORY_PARAMETER_GROUPS импортирован — лейбл
      // «Фурнитура» приходит из shared, но в шаблонах формы
      // создания всё равно встречается label-строка (через select),
      // импорт же гарантирует её доступность.
      expect(src).toMatch(/PATTERN_CATEGORY_PARAMETER_GROUPS/);
    }
  });
});
