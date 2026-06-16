/**
 * Контракты модуля «Прочие / непредвиденные расходы заказа» (этап
 * «Корректировка материалов после просчёта»).
 *
 * См. `prisma/schema.prisma::OrderExtraCost`,
 * `apps/api/src/modules/order-extra-costs/*`,
 * `apps/web/components/orders/order-extra-costs-card.tsx`.
 *
 * Назначение: дать ADMIN/SHOP_MANAGER возможность учесть расходы,
 * которые «вылезают» уже после отправки заказа на просчёт, когда состав
 * и материалы из техкарты править нельзя (логистика, аутсорс, штрафы и
 * т.п.). С `includeInCostPrice = true` каждая строка вливается в
 * `OrderCostEstimateLine` (kind=OTHER, sourceType=EXTRA_COST) при
 * `completeCalculation` / `recalculateCostEstimate`.
 *
 * Дизайн MVP:
 *   - валюта строго `RUB` / `USD` (см. `./money.ts`); USD → рубли по
 *     тому же курсу `OrderCostEstimate.usdRateRub`, что и материалы;
 *   - сумма `amount` — Decimal(14,2), положительная;
 *   - это управленческая строка, НЕ складская операция (WorkshopNeed /
 *     остатки / движения не затрагиваются).
 */

import { z } from 'zod';

import { MoneyCurrencySchema, type MoneyCurrency } from './money';

// ---------------------------------------------------------------------------
// Source type marker (для OrderCostEstimateLine.sourceType)
// ---------------------------------------------------------------------------

/**
 * Значение `OrderCostEstimateLine.sourceType` для строк, порождённых
 * `OrderExtraCost`. Хранится в БД свободной строкой (как и остальные
 * sourceType), здесь — единая константа, чтобы backend и UI не
 * расходились в написании.
 */
export const ORDER_EXTRA_COST_SOURCE_TYPE = 'EXTRA_COST';

// ---------------------------------------------------------------------------
// Field constraints
// ---------------------------------------------------------------------------

export const ORDER_EXTRA_COST_DESCRIPTION_MAX_LENGTH = 500;
export const ORDER_EXTRA_COST_COMMENT_MAX_LENGTH = 1000;
export const ORDER_EXTRA_COST_AMOUNT_MAX = 1_000_000_000;

// ---------------------------------------------------------------------------
// Reusable Zod helpers
// ---------------------------------------------------------------------------

/**
 * Сумма расхода. Принимает `string | number`, нормализует к строке с
 * `.` (без локалей), валидирует как положительное число с не более чем
 * 2 знаками после запятой (Decimal(14,2)). `> 0` — нулевой расход
 * заводить смысла нет.
 */
const AmountField: z.ZodType<string> = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const raw = typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '' || !/^\d+(\.\d{1,2})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Сумма: положительное число, не более 2 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Сумма должна быть > 0',
      });
      return z.NEVER;
    }
    if (n > ORDER_EXTRA_COST_AMOUNT_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Сумма: значение выглядит ошибочным',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string>;

/** То же, что `AmountField`, но опциональное (для PATCH). */
const OptionalAmountField: z.ZodType<string | undefined> = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const raw = typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '' || !/^\d+(\.\d{1,2})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Сумма: положительное число, не более 2 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Сумма должна быть > 0',
      });
      return z.NEVER;
    }
    if (n > ORDER_EXTRA_COST_AMOUNT_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Сумма: значение выглядит ошибочным',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | undefined>;

function optionalNullableText(maxLength: number, label: string) {
  return z.preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') return v;
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed;
    },
    z
      .string()
      .max(maxLength, `${label} не длиннее ${maxLength} символов`)
      .nullable()
      .optional(),
  );
}

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/orders/:id/extra-costs` — добавить расход.
 */
export const CreateOrderExtraCostSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1, 'Укажите описание расхода')
    .max(ORDER_EXTRA_COST_DESCRIPTION_MAX_LENGTH),
  amount: AmountField,
  currency: MoneyCurrencySchema.default('RUB'),
  includeInCostPrice: z.boolean().optional().default(true),
  comment: optionalNullableText(ORDER_EXTRA_COST_COMMENT_MAX_LENGTH, 'Комментарий'),
});
export type CreateOrderExtraCostDto = z.infer<
  typeof CreateOrderExtraCostSchema
>;

/**
 * Тело `PATCH /api/orders/:id/extra-costs/:costId` — правка расхода.
 * Любое подмножество полей; пустое тело отбивается `refine`.
 */
export const UpdateOrderExtraCostSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1, 'Описание не может быть пустым')
      .max(ORDER_EXTRA_COST_DESCRIPTION_MAX_LENGTH)
      .optional(),
    amount: OptionalAmountField,
    currency: MoneyCurrencySchema.optional(),
    includeInCostPrice: z.boolean().optional(),
    comment: optionalNullableText(
      ORDER_EXTRA_COST_COMMENT_MAX_LENGTH,
      'Комментарий',
    ),
  })
  .refine(
    (obj) =>
      obj.description !== undefined ||
      obj.amount !== undefined ||
      obj.currency !== undefined ||
      obj.includeInCostPrice !== undefined ||
      obj.comment !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateOrderExtraCostDto = z.infer<
  typeof UpdateOrderExtraCostSchema
>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface OrderExtraCostDto {
  id: string;
  orderId: string;
  description: string;
  /** Decimal как строка (`Prisma.Decimal.toString()`). */
  amount: string;
  currency: MoneyCurrency | string;
  includeInCostPrice: boolean;
  /** Статус заказа на момент добавления (`CALCULATION` / …). */
  createdAtStatus: string | null;
  comment: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}
