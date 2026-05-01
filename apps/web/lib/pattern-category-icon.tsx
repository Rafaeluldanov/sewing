/**
 * Маппинг `iconKey` → lucide-icon для UI «Категории номенклатуры».
 *
 * Хранение строкой (см. `PATTERN_CATEGORY_ICON_KEYS` в
 * `@sewing/shared/pattern-categories`) сознательно — никаких файлов
 * иконок не загружаем; UI рисует lucide. Whitelist на бэкенде, а
 * мапинг — здесь.
 */
import {
  Cookie,
  GraduationCap,
  Package,
  Scissors,
  Shirt,
  Star,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import {
  PATTERN_CATEGORY_ICON_KEYS,
  type PatternCategoryIconKey,
} from '@sewing/shared/pattern-categories';

/**
 * Map `iconKey` → lucide component. Если ключ не задан или не из
 * whitelist, возвращаем `Scissors` как универсальный fallback (это
 * та же иконка, что у самого раздела «Номенклатура»).
 *
 * Lucide не содержит часть «специфичных» иконок (например, штанов),
 * поэтому на MVP используем близкие по смыслу:
 *   - HOODIE / SHIRT  → `Shirt`
 *   - PANTS / SHORTS  → `GraduationCap` (UI рисует tag-чип, иконка
 *                       вспомогательная и легко заменяется);
 *     осознанная упрощёнка — детали видны в тексте чипа.
 *   - DRESS           → `Cookie` (визуальный аппроксимант силуэта).
 *   - CAP             → `GraduationCap`.
 *   - PACKAGE         → `Package`.
 *   - SCISSORS        → `Scissors`.
 *   - TAG             → `Tag`.
 *   - STAR            → `Star`.
 */
const ICON_MAP: Record<PatternCategoryIconKey, LucideIcon> = {
  SHIRT: Shirt,
  HOODIE: Shirt,
  PANTS: GraduationCap,
  SHORTS: GraduationCap,
  DRESS: Cookie,
  CAP: GraduationCap,
  PACKAGE: Package,
  SCISSORS: Scissors,
  TAG: Tag,
  STAR: Star,
};

export function resolvePatternCategoryIcon(
  key: string | null | undefined,
): LucideIcon {
  if (!key) return Scissors;
  if ((PATTERN_CATEGORY_ICON_KEYS as readonly string[]).includes(key)) {
    return ICON_MAP[key as PatternCategoryIconKey];
  }
  return Scissors;
}
