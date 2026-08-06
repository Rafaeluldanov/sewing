/**
 * Smoke-сторож правила «что стоит в спецификации заказа — идёт в его
 * потребность» (решение 05.08 по заказу 02-00010).
 *
 * Предыстория. В category-driven расчёте потребность строится от НОРМ
 * лекала/номенклатуры, а строки спецификации заказа только обогащают
 * найденные нормы. Строка, под роль которой нормы нет, не давала потребности
 * вообще. Фикс 07bb3c0 открыл эту ветку ТОЛЬКО для строк, заведённых руками
 * (`isManual`), и шаблонная фурнитура продолжала выпадать: у 02-00010 в
 * потребность не попали Нитки (THREAD), Молния (PACKAGING/ZIPPER) и Составник
 * (MARKING), хотя «Стропа», добавленная руками, попала.
 *
 * Сторожим ровно две вещи:
 *   1. гейта по `isManual` в этой ветке БОЛЬШЕ НЕТ — считаются все строки
 *      спецификации, и шаблонные тоже;
 *   2. гейты от двойного счёта на месте и различают СИЛУ покрытия роли:
 *      геометрия лекала (`rolesCoveredByGeometry` — площадь и погонные метры
 *      по размерам) гасит строку всегда, потому что расход выводится из
 *      лекала; норма фурнитуры (`rolesCoveredByQtyNorm`) — только пока строка
 *      с этой ролью в спецификации одна, иначе роль PACKAGING с одной
 *      заполненной нормой уносила бы из потребности всю остальную фурнитуру;
 *      плюс строка, уже ушедшая обогащением в найденную норму
 *      (`enrichedLineIds`) — совпасть она могла и по имени, при пустой роли.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

const src = readFileSync(
  path.join(
    repoRoot,
    'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
  ),
  'utf8',
);

/** Тело ветки «строки спецификации без нормы» внутри category-driven. */
function fallbackBranch(): string {
  const from = src.indexOf('Материалы СПЕЦИФИКАЦИИ ЗАКАЗА');
  expect(from).toBeGreaterThan(-1);
  const rest = src.slice(from);
  const end = rest.indexOf('Этап «Нанесение на заказе покупателя»');
  return end > -1 ? rest.slice(0, end) : rest;
}

describe('потребность цеха — строки спецификации без нормы в номенклатуре', () => {
  test('ветка считает ВСЕ строки спецификации, а не только заведённые руками', () => {
    const branch = fallbackBranch();
    expect(branch).toMatch(/for \(const line of g\.sourceLines\)/);
    // Гейт, из-за которого выпадала шаблонная фурнитура.
    expect(branch).not.toMatch(/if \(!line\.isManual\) continue;/);
  });

  test('гейты от двойного счёта на месте', () => {
    const branch = fallbackBranch();
    // Геометрия лекала закрывает роль целиком — строка гасится всегда.
    expect(branch).toMatch(
      /rolesCoveredByGeometry\.has\(role\)\)\s*continue;/,
    );
    // Норма фурнитуры — только пока строка с этой ролью одна.
    expect(branch).toMatch(/rolesCoveredByQtyNorm\.has\(role\)/);
    expect(branch).toMatch(/specLinesByRole\.get\(role\) \?\? 0\) <= 1/);
    expect(branch).toMatch(/enrichedLineIds\.has\(line\.id\)\) continue;/);
  });

  test('роли по геометрии и по норме фурнитуры собираются раздельно', () => {
    // Слить их обратно в один набор — значит вернуть дефект: одна норма
    // «Молния» уносила из потребности шнур и концевики той же роли.
    expect(src).toMatch(/const rolesCoveredByGeometry = new Set<string>\(\);/);
    expect(src).toMatch(/const rolesCoveredByQtyNorm = new Set<string>\(\);/);
    expect(src).not.toMatch(/rolesCoveredByPattern/);
  });

  test('обогащённые строки собираются по всем трём источникам норм', () => {
    // Набор заводится на группу-расцветку: sourceLines у каждой свои.
    expect(src).toMatch(/const enrichedLineIds = new Set<string>\(\);/);
    // Площади по роли, нормы фурнитуры QTY_PER_ITEM и погонные метры по
    // размерам — каждый источник помечает свою обогащающую строку.
    const adds = src.match(/enrichedLineIds\.add\(/g) ?? [];
    expect(adds.length).toBeGreaterThanOrEqual(3);
  });

  test('legacy-путь не тронут: там каждая строка источника считается и так', () => {
    expect(src).toMatch(/if \(!isCategoryDriven\) \{/);
  });
});
