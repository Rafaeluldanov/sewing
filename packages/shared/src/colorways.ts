/**
 * Контракты фичи «Расцветки» (colorways) — «разные цвета для разных
 * размеров». Этап 5 «техкарты → номенклатура»: состав материалов общий
 * для всех расцветок (спецификация карточки номенклатуры), различия
 * цветов дают правило цвета, значения слотов и ручные строки заказа.
 *
 * Бэкенд: `apps/api/src/modules/order-colorways/*`
 * (`/api/orders/:id/colorways`). Веб: `apps/web/lib/colorways-api.ts`,
 * `components/orders/colorways/*`. Фича под флагом `FEATURE_COLORWAYS`
 * (на проде OFF по умолчанию, на dev ON).
 *
 * На первом срезе структура аддитивная: `OrderVariant` /
 * `OrderVariantSize` живут рядом с `OrderItem`, который остаётся
 * агрегатом заказа. Сведение поразмерного плана по цветам в
 * производственный/раскройный контур — поздняя фаза.
 */

import { z } from 'zod';

/** Поразмерный план одной расцветки. */
export interface OrderColorwaySizeDto {
  sizeId: string;
  sizeCode: string;
  qtyPlan: number;
}

/** Расцветка заказа: цвет + поразмерный план. */
export interface OrderColorwayDto {
  id: string;
  ordinal: number;
  color: string;
  sizes: OrderColorwaySizeDto[];
}

/** Полный ответ редактора расцветок заказа. */
export interface OrderColorwaysDto {
  orderId: string;
  /** Все размеры справочника — для редактора поразмерного плана. */
  sizes: Array<{ id: string; code: string }>;
  variants: OrderColorwayDto[];
}

export const ColorwaySizeInputSchema = z.object({
  sizeId: z.string().min(1),
  qtyPlan: z.number().int().min(0).max(1_000_000),
});
export type ColorwaySizeInput = z.infer<typeof ColorwaySizeInputSchema>;

/** Тело создания / обновления расцветки. */
export const UpsertOrderColorwaySchema = z.object({
  color: z.string().trim().min(1, 'Укажите цвет расцветки').max(60),
  sizes: z.array(ColorwaySizeInputSchema).default([]),
});
export type UpsertOrderColorwayDto = z.infer<typeof UpsertOrderColorwaySchema>;
