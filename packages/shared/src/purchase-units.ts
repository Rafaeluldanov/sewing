/**
 * СЛОВАРЬ ЕДИНИЦ для строки материала спецификации: что предложить в
 * select-ах «Ед.» (норма) и «Ед.» (закупка) вместо свободного текста.
 *
 * Свободный ввод плодил варианты написания («м пог» / «мп» / «пог м»),
 * которые дальше склеивались нормализацией, но в балансах и сметах жили
 * как разные строки. Select закрывает вопрос на входе, а словарь опций
 * берётся из тех же конфигов, что и «Единица потребности» в номенклатуре:
 * подтип материала (`MATERIAL_SUBTYPES`) точнее, роль
 * (`PATTERN_CATEGORY_PARAMETER_GROUPS`) — запаснее.
 *
 * Закупочный словарь дополнительно режется ПЕРЕСЧИТЫВАЕМОСТЬЮ: единица
 * закупки, в которую `computeNormPurchase` не умеет перевести норму,
 * в списке не появляется — иначе select предлагал бы заведомый отказ
 * «NORM_NOT_LINEAR». Пересчёт умеет только из погонных метров, поэтому
 * у строки с нормой в «шт» закупка жёстко равна норме.
 *
 * Историческое значение вне словаря (старые строки со свободным вводом)
 * всегда остаётся первой опцией — select не должен молча «чинить» данные.
 */

import { getMaterialSubtype } from './material-characteristics';
import { getPatternCategoryParameterGroupConfig } from './pattern-categories';
import { normalizeUnit } from './norm-purchase';

/**
 * Единицы, в которых вводят норму расхода новой строки. Порядок = частота:
 * ткани считают метрами, фурнитуру штуками. «м/шт» — шнуры и подвязы.
 */
export const NORM_UNIT_OPTIONS: readonly string[] = [
  'м пог.',
  'м',
  'м²',
  'кг',
  'шт',
  'м/шт',
];

/** Единица нормы по умолчанию для новой строки — материалы чаще всего ткань. */
export const DEFAULT_NORM_UNIT = 'м пог.';

/**
 * Во что `computeNormPurchase` умеет пересчитать погонные метры
 * (нормализованные ключи: сама длина, площадь, вес).
 */
const CONVERTIBLE_FROM_LINEAR = new Set(['м', 'м2', 'кг']);

/**
 * Закупочные единицы, когда подтип и роль неизвестны, а норма в метрах:
 * полный пересчитываемый набор.
 */
const FALLBACK_LINEAR_PURCHASE: readonly string[] = ['м пог.', 'м²', 'кг'];

export interface NormUnitOptionsInput {
  subtypeKey?: string | null;
  /** Роль материала (`materialRole` строки = roleKey группы). */
  materialRole?: string | null;
  /** Текущее сохранённое значение — остаётся опцией, даже если вне словаря. */
  current?: string | null;
}

export interface PurchaseUnitOptionsInput extends NormUnitOptionsInput {
  /** Единица нормы строки (`normUnit ?? unit`) — из неё пересчитываем. */
  normUnit: string;
}

/**
 * Словарь по подтипу, иначе по ИЗВЕСТНОЙ роли, иначе пусто. Нарочно не
 * `getAllowedUnitsForParameterGroup`: её fallback для неизвестной роли —
 * «м²/м пог./шт» БЕЗ «кг», и строка с кастомной ролью получала бы словарь
 * хуже, чем строка вовсе без роли.
 */
function unitDictFor(
  subtypeKey: string | null | undefined,
  materialRole: string | null | undefined,
): readonly string[] {
  const subtype = subtypeKey ? getMaterialSubtype(subtypeKey) : null;
  if (subtype && subtype.allowedUnits.length > 0) return subtype.allowedUnits;
  const group = materialRole
    ? getPatternCategoryParameterGroupConfig(materialRole)
    : null;
  return group?.allowedUnits ?? [];
}

/**
 * Схлопнуть варианты написания: первая встреченная форма выигрывает, поэтому
 * `current` и единица нормы идут раньше словаря — сохранённое «м пог»
 * не задвоится словарным «м пог.».
 */
function uniqueByNormalized(units: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of units) {
    const literal = (u ?? '').trim();
    if (literal === '') continue;
    const key = normalizeUnit(literal);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(literal);
  }
  return out;
}

/**
 * Опции для select-а ЕДИНИЦЫ НОРМЫ. Известный подтип/роль ОГРАНИЧИВАЕТ
 * список (молнии не предлагаем «кг»), общий словарь — только fallback для
 * строк без подтипа и роли.
 */
export function getNormUnitOptions(input: NormUnitOptionsInput): string[] {
  const dict = unitDictFor(input.subtypeKey, input.materialRole);
  return uniqueByNormalized([
    input.current,
    ...(dict.length > 0 ? dict : NORM_UNIT_OPTIONS),
  ]);
}

/**
 * Опции для select-а ЕДИНИЦЫ ЗАКУПКИ.
 *
 * Норма не в погонных метрах → пересчёта нет, закупка равна норме: опция
 * одна (плюс историческое значение строки, если оно другое) — UI по
 * `length <= 1` дизейблит select с объяснением.
 */
export function getPurchaseUnitOptions(
  input: PurchaseUnitOptionsInput,
): string[] {
  if (normalizeUnit(input.normUnit) !== 'м') {
    return uniqueByNormalized([input.current, input.normUnit]);
  }
  const dict = unitDictFor(input.subtypeKey, input.materialRole);
  const convertible = (dict.length > 0 ? dict : FALLBACK_LINEAR_PURCHASE).filter(
    (u) => CONVERTIBLE_FROM_LINEAR.has(normalizeUnit(u)),
  );
  return uniqueByNormalized([input.current, input.normUnit, ...convertible]);
}
