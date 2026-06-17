/**
 * Smoke-тесты блока «Фурнитура и нормы» в карточке номенклатуры
 * (`/admin/patterns/[id]`).
 *
 * Контракт MVP:
 *   - в Prisma добавлена модель `PatternItemParameterNorm` с FK на
 *     `PatternItem` и `PatternCategoryParameter`;
 *   - в shared есть `PatternItemParameterNormDto`,
 *     `ReplacePatternItemParameterNormsSchema` и поле
 *     `parameterNorms` в `PatternDetailDto`;
 *   - на странице карточки появился блок «Фурнитура и нормы»;
 *   - форма блока (`parameter-norms-form.tsx`) показывает только
 *     активные параметры категории с `inputType = QTY_PER_ITEM`,
 *     не показывает `roleKey`, имеет колонку «Норма на изделие»;
 *   - server action `replacePatternItemParameterNormsAction` ходит
 *     в backend через `replacePatternItemParameterNorms` lib-клиент;
 *   - `PatternMaterialAreasForm` НЕ используется для фурнитуры —
 *     оба компонента живут параллельно, друг в друга не лезут;
 *   - `WorkshopNeedsService` создаёт строки с
 *     `sourceType = PATTERN_PARAMETER_NORM` (через
 *     `computeParameterNorm`) и не группирует роли `PACKAGING` в
 *     одну строку (агрегация — по `sourceId = norm.id`).
 *
 * Все проверки — source-level, как и остальные smoke-тесты в этой
 * папке. Backend / Prisma run-time проверяет интеграционный тест
 * `tests/integration/patterns-parameter-norms.test.ts`.
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
  'prisma/migrations/20260519100000_add_pattern_item_parameter_norms';
const MIGRATION = `${MIGRATION_DIR}/migration.sql`;
const SHARED_PATTERNS = 'packages/shared/src/patterns.ts';
const SHARED_NEEDS = 'packages/shared/src/workshop-needs.ts';
const API_SERVICE = 'apps/api/src/modules/patterns/patterns.service.ts';
const API_CONTROLLER = 'apps/api/src/modules/patterns/patterns.controller.ts';
const ERRORS = 'apps/api/src/common/errors.ts';
const NEEDS_SERVICE =
  'apps/api/src/modules/workshop-needs/workshop-needs.service.ts';
const PAGE = 'apps/web/app/admin/patterns/[id]/page.tsx';
const FORM = 'apps/web/app/admin/patterns/[id]/parameter-norms-form.tsx';
const AREAS_FORM = 'apps/web/app/admin/patterns/[id]/material-areas-form.tsx';
const ACTIONS = 'apps/web/app/admin/patterns/actions.ts';
const FORM_STATE = 'apps/web/app/admin/patterns/form-state.ts';
const PATTERNS_API = 'apps/web/lib/patterns-api.ts';

// ---------------------------------------------------------------------------
// 1. Prisma — модель и миграция
// ---------------------------------------------------------------------------

describe('PatternItemParameterNorm — Prisma и миграция', () => {
  test('schema содержит модель PatternItemParameterNorm', () => {
    const src = read(SCHEMA);
    expect(src).toMatch(/model PatternItemParameterNorm\s*\{/);
    // Обязательные поля по ТЗ §1.
    expect(src).toMatch(
      /model PatternItemParameterNorm[\s\S]*?categoryParameterId\s+String/,
    );
    expect(src).toMatch(
      /model PatternItemParameterNorm[\s\S]*?roleKey\s+String/,
    );
    expect(src).toMatch(
      /model PatternItemParameterNorm[\s\S]*?labelSnapshot\s+String/,
    );
    expect(src).toMatch(
      /model PatternItemParameterNorm[\s\S]*?inputTypeSnapshot\s+String/,
    );
    expect(src).toMatch(
      /model PatternItemParameterNorm[\s\S]*?qtyPerItem\s+Decimal/,
    );
    // Уникальность по (patternItemId, categoryParameterId).
    expect(src).toMatch(
      /@@unique\(\[patternItemId,\s*categoryParameterId\]\)/,
    );
  });

  test('PatternItem и PatternCategoryParameter получили обратные relation-поля', () => {
    const src = read(SCHEMA);
    // PatternItem.parameterNorms PatternItemParameterNorm[]
    expect(src).toMatch(
      /model PatternItem[\s\S]*?parameterNorms\s+PatternItemParameterNorm\[\]/,
    );
    // PatternCategoryParameter.patternItemNorms PatternItemParameterNorm[]
    expect(src).toMatch(
      /model PatternCategoryParameter[\s\S]*?patternItemNorms\s+PatternItemParameterNorm\[\]/,
    );
  });

  test('миграция 20260519100000_add_pattern_item_parameter_norms существует', () => {
    expect(exists(MIGRATION_DIR)).toBe(true);
    expect(exists(MIGRATION)).toBe(true);
    const sql = read(MIGRATION);
    expect(sql).toMatch(/CREATE TABLE\s+"PatternItemParameterNorm"/);
    expect(sql).toMatch(/"qtyPerItem"\s+DECIMAL\(14,4\)/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX\s+"PatternItemParameterNorm_pattern_param_uniq"/,
    );
    // FK на PatternItem и PatternCategoryParameter.
    expect(sql).toMatch(
      /FOREIGN KEY \("patternItemId"\) REFERENCES "PatternItem"/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("categoryParameterId"\) REFERENCES "PatternCategoryParameter"/,
    );
    // Чисто additive — никаких DROP / DELETE / ALTER на чужих таблицах.
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+"PatternMaterialArea"/);
    expect(sql).not.toMatch(/ALTER TABLE\s+"WorkshopNeed"/);
    expect(sql).not.toMatch(/ALTER TABLE\s+"Order"/);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared — DTO, Zod-схемы, PatternDetailDto.parameterNorms
// ---------------------------------------------------------------------------

describe('Shared DTO — Фурнитура и нормы', () => {
  const src = read(SHARED_PATTERNS);

  test('PatternItemParameterNormDto экспортируется', () => {
    expect(src).toMatch(/export interface PatternItemParameterNormDto\b/);
    // Поля snapshot нужны для расчёта потребности — не должны
    // куда-то «потеряться».
    expect(src).toMatch(/labelSnapshot:\s*string/);
    expect(src).toMatch(/inputTypeSnapshot:\s*string/);
    expect(src).toMatch(/roleKey:\s*string/);
    expect(src).toMatch(/qtyPerItem:\s*string/);
  });

  test('ReplacePatternItemParameterNormsSchema валидирует норму', () => {
    expect(src).toMatch(
      /export const ReplacePatternItemParameterNormInputSchema\b/,
    );
    expect(src).toMatch(
      /export const ReplacePatternItemParameterNormsSchema\b/,
    );
    // qtyPerItem валидируется явно.
    expect(src).toMatch(/Норма должна быть > 0/);
    expect(src).toMatch(/Норма обязательна/);
    expect(src).toMatch(/categoryParameterId обязателен/);
  });

  test('PatternDetailDto содержит parameterNorms', () => {
    expect(src).toMatch(
      /interface PatternDetailDto[\s\S]*?parameterNorms:\s*PatternItemParameterNormDto\[\]/,
    );
  });

  test('Workshop needs source types включают PATTERN_PARAMETER_NORM', () => {
    const needsSrc = read(SHARED_NEEDS);
    expect(needsSrc).toMatch(
      /WORKSHOP_NEED_SOURCE_TYPES[\s\S]*?'PATTERN_PARAMETER_NORM'/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Backend — service, controller, audit, ошибки
// ---------------------------------------------------------------------------

describe('Backend — replaceParameterNorms', () => {
  test('PatternsService.replaceParameterNorms существует', () => {
    const src = read(API_SERVICE);
    expect(src).toMatch(/async replaceParameterNorms\b/);
    // Whitelist — активные параметры категории с QTY_PER_ITEM.
    expect(src).toMatch(/inputType:\s*['"]QTY_PER_ITEM['"]/);
    expect(src).toMatch(/status:\s*['"]ACTIVE['"]/);
    // Snapshot полей: labelSnapshot / inputTypeSnapshot / roleKey
    // приходят из параметра категории.
    expect(src).toMatch(/labelSnapshot:\s*param\.label/);
    expect(src).toMatch(/inputTypeSnapshot:\s*param\.inputType/);
    expect(src).toMatch(/roleKey:\s*param\.roleKey/);
    // Аудит-событие.
    expect(src).toMatch(/PATTERN_PARAMETER_NORMS_REPLACED/);
    // Ошибка валидации.
    expect(src).toMatch(/PatternParameterNormNotAllowedException/);
  });

  test('PatternsController имеет PUT /:id/parameter-norms', () => {
    const src = read(API_CONTROLLER);
    expect(src).toMatch(
      /@Put\(['"]:id\/parameter-norms['"]\)[\s\S]*?replaceParameterNorms/,
    );
    expect(src).toMatch(/ReplacePatternItemParameterNormsSchema/);
  });

  test('Errors — PatternParameterNormNotAllowedException + код PATTERN_PARAMETER_NORM_NOT_ALLOWED', () => {
    const src = read(ERRORS);
    expect(src).toMatch(/class PatternParameterNormNotAllowedException\b/);
    expect(src).toMatch(/PATTERN_PARAMETER_NORM_NOT_ALLOWED/);
  });

  test('PatternDetailDto содержит parameterNorms (sorted by sortOrder)', () => {
    const src = read(API_SERVICE);
    // include parameterNorms на getOne.
    expect(src).toMatch(/parameterNorms:\s*\{[\s\S]*?categoryParameter:\s*true/);
    // toDetailDto мапит parameterNorms.
    expect(src).toMatch(/parameterNorms,/);
  });
});

// ---------------------------------------------------------------------------
// 4. WorkshopNeedsService — PATTERN_PARAMETER_NORM-строки
// ---------------------------------------------------------------------------

describe('WorkshopNeedsService — расчёт по нормам фурнитуры', () => {
  const src = read(NEEDS_SERVICE);

  test('загружает parameterNorms через include patternItem', () => {
    expect(src).toMatch(
      /patternItem:\s*\{[\s\S]*?include:\s*\{[\s\S]*?parameterNorms:\s*true/,
    );
  });

  test('создаёт ComputedNeed из каждой нормы (PATTERN_PARAMETER_NORM)', () => {
    expect(src).toMatch(/computeParameterNorm\b/);
    expect(src).toMatch(/sourceType:\s*['"]PATTERN_PARAMETER_NORM['"]/);
    // Формула: qtyPerItem × totalOrderQty.
    expect(src).toMatch(/norm\.qtyPerItem[\s\S]*?\.mul\(totalOrderQty\)/);
    // sourceId = norm.id (отдельные строки на Люверсы / Шнур / Наконечники).
    expect(src).toMatch(/sourceId:\s*norm\.id/);
    // materialRole = norm.roleKey (snapshot).
    expect(src).toMatch(/materialRole:\s*norm\.roleKey/);
  });

  test('фильтрует по inputTypeSnapshot = QTY_PER_ITEM', () => {
    expect(src).toMatch(
      /norm\.inputTypeSnapshot\s*!==\s*['"]QTY_PER_ITEM['"]/,
    );
  });

  test('ComputedNeed sourceType расширен PATTERN_PARAMETER_NORM', () => {
    expect(src).toMatch(/'PATTERN_PARAMETER_NORM'/);
  });
});

// ---------------------------------------------------------------------------
// 5. Frontend — страница, форма, server action
// ---------------------------------------------------------------------------

describe('admin/patterns/[id] — блок «Нормы на изделие»', () => {
  test('страница подключает PatternItemParameterNormsForm', () => {
    const src = read(PAGE);
    expect(src).toMatch(/from '\.\/parameter-norms-form'/);
    expect(src).toMatch(/<PatternItemParameterNormsForm\b/);
    expect(src).toMatch(/Нормы на изделие/);
  });

  test('форма «Нормы на изделие» — клиентский компонент, не показывает roleKey', () => {
    expect(exists(FORM)).toBe(true);
    const src = read(FORM);
    expect(src.startsWith("'use client'")).toBe(true);
    // ТЗ §6 «не показывать roleKey пользователю».
    // Допускаем совпадения в комментариях, но в JSX используется только label.
    expect(src).not.toMatch(/\{p\.roleKey\}/);
    expect(src).not.toMatch(/\{parameter\.roleKey\}/);
    // Терминология ТЗ §6.
    expect(src).toMatch(/Норма на изделие/);
    expect(src).toMatch(/Параметр/);
    expect(src).toMatch(/Единица/);
    expect(src).toMatch(/Комментарий/);
  });

  test('форма берёт только QTY_PER_ITEM активные параметры', () => {
    const src = read(FORM);
    expect(src).toMatch(/inputType\s*===\s*['"]QTY_PER_ITEM['"]/);
    expect(src).toMatch(/status\s*===\s*['"]ACTIVE['"]/);
  });

  test('форма ходит в replacePatternItemParameterNormsAction', () => {
    const src = read(FORM);
    expect(src).toMatch(/replacePatternItemParameterNormsAction/);
  });

  test('PatternMaterialAreasForm не использует QTY_PER_ITEM как фильтр', () => {
    // Гарантия, что фурнитура не утекла в «Площади материалов»:
    // фильтрация колонок идёт ровно по AREA_M2_BY_SIZE. Упоминания
    // QTY_PER_ITEM в комментариях допустимы (объясняют, почему
    // фурнитура сюда не попадает), но в коде фильтра — только
    // AREA_M2_BY_SIZE.
    const src = read(AREAS_FORM);
    expect(src).toMatch(/AREA_M2_BY_SIZE/);
    expect(src).toMatch(
      /inputType\s*===\s*['"]AREA_M2_BY_SIZE['"][\s\S]{0,80}status\s*===\s*['"]ACTIVE['"]/,
    );
    // Никакого QTY_PER_ITEM-кода — ни в фильтре, ни в JSX.
    expect(src).not.toMatch(
      /inputType\s*===\s*['"]QTY_PER_ITEM['"]/,
    );
  });

  test('страница рисует empty-state «выберите категорию» / «нет параметров»', () => {
    const src = read(PAGE);
    expect(src).toMatch(/Выберите категорию, чтобы настроить фурнитуру\./);
    expect(src).toMatch(/В категории нет параметров фурнитуры/);
  });
});

describe('admin/patterns — server action и lib-клиент', () => {
  test('replacePatternItemParameterNormsAction экспортирован', () => {
    const src = read(ACTIONS);
    expect(src).toMatch(
      /export async function replacePatternItemParameterNormsAction\b/,
    );
    // Парсит __parameterIds и пустые qty пропускает.
    expect(src).toMatch(/__parameterIds/);
    // Использует ReplacePatternItemParameterNormInputSchema.
    expect(src).toMatch(/ReplacePatternItemParameterNormInputSchema/);
  });

  test('ParameterNormsState добавлен в form-state', () => {
    const src = read(FORM_STATE);
    expect(src).toMatch(/export interface ParameterNormsState\b/);
    expect(src).toMatch(/initialParameterNormsState/);
  });

  test('replacePatternItemParameterNorms добавлен в patterns-api', () => {
    const src = read(PATTERNS_API);
    expect(src).toMatch(
      /export function replacePatternItemParameterNorms\b/,
    );
    expect(src).toMatch(/parameter-norms/);
  });
});
