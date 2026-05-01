/**
 * Контракты модуля «Себестоимость заказа» (см.
 * `prisma/schema.prisma::OrderCostEstimate` /
 * `OrderCostEstimateLine`,
 * `apps/api/src/modules/orders/orders.service.ts::completeCalculation` /
 * `reopenCalculation`).
 *
 * Дизайн MVP:
 *   - расчёт строится только из существующих `WorkshopNeed`
 *     (источник строк не меняем);
 *   - валюта строго `RUB` / `USD` (см. `./money.ts`); USD →
 *     рубли по ручному курсу, без exchange-rate API;
 *   - история завершённых расчётов хранится в
 *     `OrderCostEstimate` (одна строка `COMPLETED`, прочие
 *     `REVOKED`); удалять расчёты нельзя — `reopen` помечает
 *     старый как `REVOKED` и стирает snapshot-поля заказа.
 */

import { z } from 'zod';

import { MoneyCurrencySchema, type MoneyCurrency } from './money';

// ---------------------------------------------------------------------------
// Statuses / kinds
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл документа `OrderCostEstimate`:
 *
 *   - `COMPLETED` — активный расчёт, `Order.costEstimateTotalRub`
 *     указывает именно на него;
 *   - `REVOKED`   — расчёт был отозван (`reopenCalculation`),
 *     остаётся в БД для аудита, но в snapshot заказа больше не
 *     участвует.
 *
 * Расширение списка не требует миграции (поле — обычная строка).
 */
export const ORDER_COST_ESTIMATE_STATUSES = ['COMPLETED', 'REVOKED'] as const;
export type OrderCostEstimateStatus =
  (typeof ORDER_COST_ESTIMATE_STATUSES)[number];
export const OrderCostEstimateStatusSchema = z.enum(
  ORDER_COST_ESTIMATE_STATUSES,
);

/**
 * Управленческий «тип» строки расчёта. Соответствует UI-секциям
 * блока «Себестоимость» в карточке заказа: «Материалы / Фурнитура /
 * Нанесение / Прочее». Источник истины — `getWorkshopNeedKind` из
 * `./workshop-needs`; здесь повторяем массив, чтобы зависимости не
 * закольцевались.
 */
export const ORDER_COST_ESTIMATE_LINE_KINDS = [
  'MATERIAL',
  'HARDWARE',
  'APPLICATION',
  'OTHER',
] as const;
export type OrderCostEstimateLineKind =
  (typeof ORDER_COST_ESTIMATE_LINE_KINDS)[number];

export const ORDER_COST_ESTIMATE_LINE_KIND_LABELS: Record<
  OrderCostEstimateLineKind,
  string
> = {
  MATERIAL: 'Материалы',
  HARDWARE: 'Фурнитура',
  APPLICATION: 'Нанесение',
  OTHER: 'Прочее',
};

// ---------------------------------------------------------------------------
// Reusable Zod helpers
// ---------------------------------------------------------------------------

/**
 * USD-курс к рублю. Принимает `string | number | null | undefined`,
 * нормализует к строке с `.` (без локалей), валидирует как
 * положительное число с не более чем 4 знаками после запятой.
 *
 * Поле опциональное на уровне DTO: если хотя бы одна строка
 * `WorkshopNeed` в `USD`, backend требует курс отдельной 422-кой
 * (`ORDER_CALCULATION_USD_RATE_REQUIRED`); иначе — допускает `null`.
 */
const UsdRateRubField: z.ZodType<string | null | undefined> = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const raw =
      typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') return null;
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Курс USD: положительное число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Курс USD должен быть > 0',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | null | undefined>;

/**
 * Optional comment / reason — пустую строку нормализуем в `null`.
 */
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
 * Тело `POST /api/orders/:id/complete-calculation` (см.
 * `OrdersController.completeCalculation`).
 *
 * `usdRateRub` обязательно, если по заказу есть строки `WorkshopNeed`
 * в `USD`. Backend сам это проверяет — DTO принимает `null/undefined`,
 * чтобы UI мог отдать форму один раз и не дублировать guard.
 */
export const CompleteOrderCalculationSchema = z.object({
  usdRateRub: UsdRateRubField,
  comment: optionalNullableText(500, 'Комментарий'),
});
export type CompleteOrderCalculationDto = z.infer<
  typeof CompleteOrderCalculationSchema
>;

/**
 * Тело `POST /api/orders/:id/reopen-calculation`.
 *
 * `reason` — произвольный комментарий «почему вернули на пересчёт»;
 * пишется в `OrderCostEstimate.comment` отзываемого расчёта.
 */
export const ReopenOrderCalculationSchema = z.object({
  reason: optionalNullableText(500, 'Причина'),
});
export type ReopenOrderCalculationDto = z.infer<
  typeof ReopenOrderCalculationSchema
>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

/**
 * Строка расчёта себестоимости. Все Decimal-поля сериализуются строкой
 * (`Prisma.Decimal.toString()`), как и в остальных DTO проекта
 * (`WorkshopNeedDto`, `OrderMaterialRequirementDto`).
 */
export interface OrderCostEstimateLineDto {
  id: string;
  estimateId: string;
  workshopNeedId: string | null;
  sourceType: string | null;
  sourceId: string | null;

  kind: OrderCostEstimateLineKind | string;
  description: string;
  unit: string;

  /** Decimal как строка; `null`, если расчёт системы не требовался. */
  calculatedQty: string | null;
  /** Decimal как строка; всегда заполнен (использовали для расчёта итога). */
  purchaseQty: string;

  quotedPrice: string;
  quotedCurrency: MoneyCurrency | string;
  /** Decimal как строка; `null` для RUB-строк. */
  usdRateRub: string | null;

  /** `purchaseQty × quotedPrice` в исходной валюте. */
  lineTotalOriginal: string;
  /** Тот же итог в рублях (для USD = `lineTotalOriginal × usdRateRub`). */
  lineTotalRub: string;

  supplierNameSnapshot: string | null;
  purchaseItemNameSnapshot: string | null;

  createdAt: string;
  updatedAt: string;
}

/**
 * Документ «Себестоимость заказа». Используется в
 * `OrderDetailDto.currentCostEstimate` и в будущем — для отдельного
 * GET-эндпоинта истории расчётов.
 */
export interface OrderCostEstimateDto {
  id: string;
  orderId: string;
  version: number;
  status: OrderCostEstimateStatus | string;

  /** Decimal как строка. */
  totalCostRub: string;
  /** Decimal как строка; `null`, если в расчёте не было USD-строк. */
  usdRateRub: string | null;

  completedAt: string;
  completedById: string | null;
  completedByName: string | null;

  revokedAt: string | null;
  revokedById: string | null;
  revokedByName: string | null;

  comment: string | null;

  lines: OrderCostEstimateLineDto[];

  createdAt: string;
  updatedAt: string;
}
