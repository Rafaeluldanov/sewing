/**
 * «Материалы в номенклатуре» — этап 1 плана «техкарты → номенклатура»
 * (анализ 11.08.2026).
 *
 * Карточка номенклатуры (`PatternItem`) получает собственный СОСТАВ
 * материалов: строки (`PatternItemMaterialLine`) + слоты-параметры
 * (`PatternItemSpecParameter`). Контракт строки сознательно 1-в-1 со
 * строкой техкарты: на этапе 3 источником снапшота заказа
 * (`OrderMaterialRequirement`) станет номенклатура, и весь снапшотный
 * конвейер (характеристики, параметры, `computeNormPurchase`) должен
 * переиспользоваться без изменений. Поэтому схемы/DTO импортируются из
 * `./tech-cards` / `./tech-card-parameters`, а не копируются; когда
 * техкарты будут удалены (этап 5), базовые схемы переедут сюда.
 */
import { z } from 'zod';

import {
  TECH_CARD_LINE_UNIT_MAX_LENGTH,
  TECH_CARD_MAX_LINES_PER_SECTION,
  TECH_CARD_MAX_PARAMETERS,
  TechCardMaterialLineInputBaseSchema,
  materialLineFixedColorCheck,
  withParameterCrossChecks,
  type TechCardMaterialLineDto,
} from './tech-cards';
import {
  TechCardParameterInputSchema,
  type TechCardParameterDto,
  type TechCardParameterInput,
} from './tech-card-parameters';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Строка состава материалов номенклатуры. Поверх строки техкарты добавляет
 * `normUnit` — единицу НОРМЫ, если она отличается от закупочной («м пог.»
 * при закупке в «кг»). В техкарте колонка существовала, но формой не
 * редактировалась — здесь пробел закрыт (см. анализ, таблица пробелов).
 */
export const PatternItemMaterialLineInputSchema =
  TechCardMaterialLineInputBaseSchema.extend({
    normUnit: z
      .string()
      .trim()
      .max(TECH_CARD_LINE_UNIT_MAX_LENGTH)
      .nullish(),
  }).superRefine(materialLineFixedColorCheck);
export type PatternItemMaterialLineInput = z.infer<
  typeof PatternItemMaterialLineInputSchema
>;

/** Слот-параметр спецификации — контракт идентичен параметру техкарты. */
export const PatternItemSpecParameterInputSchema = TechCardParameterInputSchema;
export type PatternItemSpecParameterInput = TechCardParameterInput;

/**
 * `PUT /api/patterns/:id/material-spec` — full-replace обеих частей разом
 * (строки + параметры), как `TechCardsService.update`. В отличие от PATCH
 * техкарты, запрос всегда несёт полное итоговое состояние, поэтому
 * кросс-проверка «биндинг ссылается на объявленный параметр» авторитетно
 * выполняется прямо в схеме (`withParameterCrossChecks`).
 */
export const ReplacePatternItemMaterialSpecSchema = z
  .object({
    materialLines: z
      .array(PatternItemMaterialLineInputSchema)
      .max(
        TECH_CARD_MAX_LINES_PER_SECTION,
        `Максимум ${TECH_CARD_MAX_LINES_PER_SECTION} строк материалов`,
      )
      .default([]),
    parameters: z
      .array(PatternItemSpecParameterInputSchema)
      .max(
        TECH_CARD_MAX_PARAMETERS,
        `Максимум ${TECH_CARD_MAX_PARAMETERS} параметров`,
      )
      .default([]),
  })
  .superRefine(withParameterCrossChecks);
export type ReplacePatternItemMaterialSpecDto = z.infer<
  typeof ReplacePatternItemMaterialSpecSchema
>;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/** Строка состава в DTO карточки номенклатуры: строка техкарты + `normUnit`. */
export interface PatternItemMaterialLineDto extends TechCardMaterialLineDto {
  normUnit: string | null;
}

/** Слот-параметр в DTO карточки — контракт идентичен параметру техкарты. */
export type PatternItemSpecParameterDto = TechCardParameterDto;
