/**
 * Контракты «Параметры техкарты внутри заказа».
 *
 * Технолог открывает расцветку и заполняет слоты, объявленные в шаблоне
 * («Плотность полотна» = 190), либо заводит свой — прямо в заказе. Значения
 * ВСЕГДА принадлежат расцветке: наследования «уровень заказа → расцветка» нет
 * (оно порождает вопрос «унаследовано или переопределено» и второй источник
 * истины). От повторного ввода спасает `apply-to-all-variants` — разовое
 * копирование, а не связь.
 *
 * Модуль — зеркало `./colorways.ts`: те же правила (правка только в
 * DRAFT/CALCULATION, каждый write возвращает свежий полный DTO).
 */

import { z } from 'zod';

import {
  TechCardParameterInputTypeSchema,
  TechCardParameterKeySchema,
  TechCardParameterTargetSchema,
  type OrderTechCardParameterDto,
} from './tech-card-parameters';

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

/** Ячейка строки материала, доступная для привязки ad-hoc параметра. */
export interface OrderTechCardTargetOptionDto {
  /** `OrderMaterialRequirement.id` — строка снимка ЭТОЙ расцветки. */
  requirementId: string;
  lineName: string;
  field: string;
  fieldLabel: string;
  valueType: 'text' | 'number';
  unit: string | null;
  /** Ячейка уже занята другим параметром — привязать второй нельзя. */
  takenByKey: string | null;
}

/** Параметры одной расцветки (или order-level группы при 0–1 расцветке). */
export interface OrderTechCardVariantParamsDto {
  orderVariantId: string | null;
  color: string | null;
  techCardId: string | null;
  techCardName: string | null;
  parameters: OrderTechCardParameterDto[];
  /** Сколько обязательных слотов ещё пустые (для плитки расцветки). */
  missingRequiredCount: number;
  /** Куда можно привязать новый параметр. */
  targets: OrderTechCardTargetOptionDto[];
}

export interface OrderTechCardParametersDto {
  orderId: string;
  /** Правка разрешена только в DRAFT/CALCULATION (см. `ORDER_TECH_CARD_LOCKED`). */
  editable: boolean;
  variants: OrderTechCardVariantParamsDto[];
}

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

/**
 * Значение слота. `null` / пустая строка = «не заполнено»: ячейка остаётся
 * значением из шаблона, а заказ не пустят в расчёт (`ORDER_SPEC_INCOMPLETE`).
 */
export const SetOrderTechCardParameterValueSchema = z.object({
  value: z.string().trim().max(200).nullish(),
});
export type SetOrderTechCardParameterValueDto = z.infer<
  typeof SetOrderTechCardParameterValueSchema
>;

/**
 * Ad-hoc слот, заведённый прямо в заказе (в шаблоне его нет).
 *
 * `target` обязателен по смыслу: параметр — это переменная, подставляемая в
 * ЯЧЕЙКУ. Без цели значение некуда девать. Исключение — `target: null`:
 * «просто зафиксировать в спецификации» (параметр-запись для цеха, ни на что
 * не влияет).
 */
export const CreateOrderTechCardParameterSchema = z
  .object({
    /** null = order-level группа (заказ с 0–1 расцветкой). */
    orderVariantId: z.string().min(1).nullish(),
    key: TechCardParameterKeySchema,
    label: z.string().trim().min(1, 'Укажите название параметра').max(120),
    inputType: TechCardParameterInputTypeSchema.default('TEXT'),
    options: z.array(z.string().trim().min(1)).max(50).optional(),
    unit: z.string().trim().max(20).nullish(),
    isRequired: z.boolean().default(false),
    value: z.string().trim().max(200).nullish(),
    target: z
      .object({
        requirementId: z.string().min(1),
        field: TechCardParameterTargetSchema,
      })
      .nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.inputType === 'ENUM' && (!v.options || v.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Для параметра-списка укажите хотя бы одно значение',
      });
    }
  });
export type CreateOrderTechCardParameterDto = z.infer<
  typeof CreateOrderTechCardParameterSchema
>;

/**
 * Вынести техкарту расцветки в справочник как НОВЫЙ шаблон.
 *
 * Уезжает СТРУКТУРА: строки материалов + определения параметров (включая
 * ad-hoc, заведённые в заказе). Значения — НЕ уезжают: иначе новый шаблон
 * унесёт «190 г/м²» намертво вместе с параметром «плотность», то есть
 * воспроизведёт ровно ту болезнь близнецов, ради которой фича и делается.
 *
 * Заказ при этом не трогаем: на новый шаблон он не перенаправляется.
 * Мостик работает только наружу — «что меняем внутри заказа, внутри заказа
 * и остаётся».
 */
export const SaveOrderTechCardAsTemplateSchema = z.object({
  /** Чью техкарту выносим. null = order-level группа (0–1 расцветка). */
  orderVariantId: z.string().min(1).nullish(),
  code: z.string().trim().min(1, 'Укажите код техкарты').max(64),
  name: z.string().trim().min(1, 'Укажите название техкарты').max(200),
});
export type SaveOrderTechCardAsTemplateDto = z.infer<
  typeof SaveOrderTechCardAsTemplateSchema
>;

export type { OrderTechCardParameterDto };
