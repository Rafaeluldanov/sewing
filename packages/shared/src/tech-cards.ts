/**
 * Контракты модуля «Техкарты» (tech cards, MVP).
 *
 * См. `docs/domain.md §«Техкарты»`, ADR-0022. На MVP это простой
 * справочник:
 *   - менеджер создаёт `TechCardTemplate` со списками строк (материалы
 *     + внешние подрядные размещения, OUTSOURCED_SERVICE);
 *   - при создании заказа можно опционально привязать `techCardId`;
 *   - при первом `OrdersService.start()` строки фиксируются в snapshot-ы
 *     `OrderMaterialRequirement[]` и `OrderOutsourceRequirement[]`
 *     (см. `OrderDetailDto.materialRequirements`/`outsourceRequirements`);
 *   - НИКАКИХ формул, размеров, коэффициентов: `totalQty = qtyPerUnit *
 *     Σ qtyPlan` по строкам заказа (см. `OrdersService.start`).
 *
 * Zod-схемы здесь — источник истины для валидации запросов на API и
 * клиентских форм; типы выведены из них.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Reusable fields
// ---------------------------------------------------------------------------

export const TECH_CARD_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,47}$/;
export const TECH_CARD_CODE_MAX_LENGTH = 48;
export const TECH_CARD_NAME_MAX_LENGTH = 120;
export const TECH_CARD_LINE_NAME_MAX_LENGTH = 200;
export const TECH_CARD_LINE_UNIT_MAX_LENGTH = 32;
export const TECH_CARD_LINE_NOTE_MAX_LENGTH = 500;
export const TECH_CARD_LINE_VENDOR_NAME_MAX_LENGTH = 120;
export const TECH_CARD_MAX_LINES_PER_SECTION = 200;

const TechCardCodeField = z
  .string()
  .trim()
  .min(1, 'Код техкарты обязателен')
  .max(
    TECH_CARD_CODE_MAX_LENGTH,
    `Код техкарты не длиннее ${TECH_CARD_CODE_MAX_LENGTH} символов`,
  )
  .regex(
    TECH_CARD_CODE_PATTERN,
    'Код техкарты: латинские заглавные буквы, цифры, "-" и "_" (начинается с буквы или цифры)',
  );

const TechCardNameField = z
  .string()
  .trim()
  .min(1, 'Название техкарты обязательно')
  .max(
    TECH_CARD_NAME_MAX_LENGTH,
    `Название техкарты не длиннее ${TECH_CARD_NAME_MAX_LENGTH} символов`,
  );

const LineNameField = z
  .string()
  .trim()
  .min(1, 'Название строки обязательно')
  .max(
    TECH_CARD_LINE_NAME_MAX_LENGTH,
    `Название строки не длиннее ${TECH_CARD_LINE_NAME_MAX_LENGTH} символов`,
  );

const LineUnitRequiredField = z
  .string()
  .trim()
  .min(1, 'Единица измерения обязательна')
  .max(
    TECH_CARD_LINE_UNIT_MAX_LENGTH,
    `Единица измерения не длиннее ${TECH_CARD_LINE_UNIT_MAX_LENGTH} символов`,
  );

const LineUnitOptionalField = z
  .string()
  .trim()
  .max(
    TECH_CARD_LINE_UNIT_MAX_LENGTH,
    `Единица измерения не длиннее ${TECH_CARD_LINE_UNIT_MAX_LENGTH} символов`,
  )
  .nullable()
  .optional()
  .transform((v) => (v == null || v === '' ? null : v));

const LineNoteField = z
  .string()
  .trim()
  .max(
    TECH_CARD_LINE_NOTE_MAX_LENGTH,
    `Примечание не длиннее ${TECH_CARD_LINE_NOTE_MAX_LENGTH} символов`,
  )
  .nullable()
  .optional()
  .transform((v) => (v == null || v === '' ? null : v));

const VendorNameField = z
  .string()
  .trim()
  .max(
    TECH_CARD_LINE_VENDOR_NAME_MAX_LENGTH,
    `Подрядчик не длиннее ${TECH_CARD_LINE_VENDOR_NAME_MAX_LENGTH} символов`,
  )
  .nullable()
  .optional()
  .transform((v) => (v == null || v === '' ? null : v));

/**
 * `qtyPerUnit` хранится как Decimal(12,4). Принимаем как `string` или
 * `number`, нормализуем к строке с `.` (без локалей) и валидируем как
 * положительное число с не более чем 4 знаками после запятой. Возвращаем
 * строку — её `Prisma.Decimal` принимает как есть.
 */
function makeQtyField(opts: { required: boolean }): z.ZodType<string | null> {
  const base = z.union([z.string(), z.number()]).transform((v, ctx) => {
    const raw = typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') {
      if (opts.required) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Норма расхода обязательна',
        });
        return z.NEVER;
      }
      return null as string | null;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Норма расхода: положительное число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Норма расхода должна быть > 0',
      });
      return z.NEVER;
    }
    return raw;
  });
  if (opts.required) {
    return base as unknown as z.ZodType<string | null>;
  }
  return base.nullable().optional().transform((v) => (v == null ? null : v)) as
    unknown as z.ZodType<string | null>;
}

// ---------------------------------------------------------------------------
// Line input DTO
// ---------------------------------------------------------------------------

/**
 * Строка материала. `sortOrder` НЕ принимается из формы — backend
 * нормализует порядок по позиции в массиве (`(i + 1) * 10`).
 */
export const TechCardMaterialLineInputSchema = z.object({
  name: LineNameField,
  unit: LineUnitRequiredField,
  qtyPerUnit: makeQtyField({ required: true }),
  note: LineNoteField,
});
export type TechCardMaterialLineInputDto = z.infer<
  typeof TechCardMaterialLineInputSchema
>;

/**
 * Строка внешнего подрядного размещения. Большая часть полей
 * опциональна — иногда подряд считается «за партию» без явной нормы.
 */
export const TechCardOutsourceLineInputSchema = z.object({
  name: LineNameField,
  unit: LineUnitOptionalField,
  qtyPerUnit: makeQtyField({ required: false }),
  vendorName: VendorNameField,
  note: LineNoteField,
});
export type TechCardOutsourceLineInputDto = z.infer<
  typeof TechCardOutsourceLineInputSchema
>;

const MaterialLinesField = z
  .array(TechCardMaterialLineInputSchema)
  .max(
    TECH_CARD_MAX_LINES_PER_SECTION,
    `Максимум ${TECH_CARD_MAX_LINES_PER_SECTION} строк материалов`,
  );

const OutsourceLinesField = z
  .array(TechCardOutsourceLineInputSchema)
  .max(
    TECH_CARD_MAX_LINES_PER_SECTION,
    `Максимум ${TECH_CARD_MAX_LINES_PER_SECTION} строк внешних потребностей`,
  );

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

export const CreateTechCardSchema = z.object({
  code: TechCardCodeField,
  name: TechCardNameField,
  isActive: z.boolean().optional().default(true),
  materialLines: MaterialLinesField.default([]),
  outsourceLines: OutsourceLinesField.default([]),
});
export type CreateTechCardDto = z.infer<typeof CreateTechCardSchema>;

export const UpdateTechCardSchema = z
  .object({
    code: TechCardCodeField.optional(),
    name: TechCardNameField.optional(),
    isActive: z.boolean().optional(),
    materialLines: MaterialLinesField.optional(),
    outsourceLines: OutsourceLinesField.optional(),
  })
  .refine(
    (obj) =>
      obj.code !== undefined ||
      obj.name !== undefined ||
      obj.isActive !== undefined ||
      obj.materialLines !== undefined ||
      obj.outsourceLines !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateTechCardDto = z.infer<typeof UpdateTechCardSchema>;

// ---------------------------------------------------------------------------
// List query DTO
// ---------------------------------------------------------------------------

export const ListTechCardsQuerySchema = z.object({
  /**
   * `true`  — только активные (для UI выбора техкарты при создании заказа);
   * `false` — только неактивные;
   * не указан — все (для админа).
   */
  isActive: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (typeof v === 'boolean') return v;
      return v === 'true';
    }),
  search: z.string().trim().max(100).optional(),
});
export type ListTechCardsQuery = z.infer<typeof ListTechCardsQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface TechCardMaterialLineDto {
  id: string;
  sortOrder: number;
  name: string;
  unit: string;
  /** Decimal как строка (см. `Prisma.Decimal`). */
  qtyPerUnit: string;
  note: string | null;
}

export interface TechCardOutsourceLineDto {
  id: string;
  sortOrder: number;
  name: string;
  unit: string | null;
  qtyPerUnit: string | null;
  vendorName: string | null;
  note: string | null;
}

export interface TechCardTemplateSummaryDto {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  materialLinesCount: number;
  outsourceLinesCount: number;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface TechCardTemplateDetailDto extends TechCardTemplateSummaryDto {
  materialLines: TechCardMaterialLineDto[];
  outsourceLines: TechCardOutsourceLineDto[];
}
