/**
 * Текст предупреждения перед удалением группы номенклатуры.
 *
 * Живёт отдельным модулем, потому что кнопок удаления две и они в
 * разных разделах — чип-фильтр на `/admin/patterns`
 * (`delete-category-chip-button.tsx`) и карточка группы
 * `/admin/pattern-categories/[id]` (`delete-pattern-category-button.tsx`).
 * Формулировка должна быть ОДНА: удаление группы каскадом уводит её
 * номенклатуру в архив (`PatternCategoriesService.remove`), и менеджер
 * обязан увидеть одинаковое предупреждение независимо от того, откуда
 * нажал.
 *
 * Модуль чистый (без React/DOM) — импортируется из client-компонентов.
 */

/**
 * Русское склонение слова «номенклатура» по числу: 1 номенклатура,
 * 2 номенклатуры, 5 номенклатур.
 */
export function pluralPatterns(count: number): string {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return 'номенклатур';
  if (n1 > 1 && n1 < 5) return 'номенклатуры';
  if (n1 === 1) return 'номенклатура';
  return 'номенклатур';
}

/**
 * Одна строка про содержимое группы — общая для `window.confirm` и для
 * inline-предупреждения на карточке группы. `null`, если группа пуста.
 */
export function describeCategoryContents(
  patternsCount: number,
): string | null {
  const parts: string[] = [];
  if (patternsCount > 0) {
    parts.push(
      `${patternsCount} ${pluralPatterns(patternsCount)} уйдёт в архив ` +
        '«Номенклатуры» (оттуда можно вернуть)',
    );
  }
  if (parts.length === 0) return null;
  return parts.join('; ');
}

/**
 * Текст `window.confirm` для удаления группы.
 *
 * Счётчик берётся из серверной DTO группы
 * (`PatternCategoryDto.patternsCount`) — считает его backend, UI ничего
 * не выдумывает.
 */
export function buildCategoryDeleteConfirmText(
  categoryName: string,
  patternsCount: number,
): string {
  const contents = describeCategoryContents(patternsCount);
  if (!contents) {
    return (
      `Удалить группу «${categoryName}» НАВСЕГДА?\n\n` +
      'Вместе с группой пропадут её параметры материалов. ' +
      'Действие необратимо.'
    );
  }
  return (
    `Удалить группу «${categoryName}» НАВСЕГДА?\n\n` +
    `Внутри группы: ${contents}.\n\n` +
    'Сама группа и её параметры материалов удалятся безвозвратно — ' +
    'вместе с параметрами пропадут заданные по ним площади и нормы ' +
    'номенклатуры. Действие необратимо.'
  );
}
