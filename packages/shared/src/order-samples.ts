/**
 * Контракты модуля «Сигнальный образец» (MVP).
 *
 * Источник истины:
 *   - `prisma/schema.prisma::OrderSample` / `OrderSampleStatus` /
 *     `OrderSampleMaterialMode` / `Passport.sampleId`
 *   - `apps/api/src/modules/order-samples/*`
 *   - `docs/order-signal-sample-flow.md`
 *   - `docs/order-signal-sample-recon.md`
 *
 * Дизайн (см. RECON §3):
 *   - Zod-схемы — единственный источник валидации запросов на API и
 *     форм на web;
 *   - response DTO — TS-интерфейсы (как в `passports.ts`);
 *   - НЕ мутируем `OrderItem.qtyPlan` — эффект на тираж считается
 *     логически и отдаётся в `OrderSampleBulkEffectDto`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums (мирорят prisma/schema.prisma)
// ---------------------------------------------------------------------------

export const ORDER_SAMPLE_STATUSES = [
  'IN_PROGRESS',
  'READY_FOR_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export const OrderSampleStatusSchema = z.enum(ORDER_SAMPLE_STATUSES);
export type OrderSampleStatus = z.infer<typeof OrderSampleStatusSchema>;

export const ORDER_SAMPLE_MATERIAL_MODES = [
  'SAMPLE_ONLY',
  'FULL_ORDER',
] as const;
export const OrderSampleMaterialModeSchema = z.enum(
  ORDER_SAMPLE_MATERIAL_MODES,
);
export type OrderSampleMaterialMode = z.infer<
  typeof OrderSampleMaterialModeSchema
>;

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/orders/:orderId/samples/start`.
 *
 * Валидация:
 *   - `productId` / `sizeId` — обязательны, бэкенд проверит, что пара
 *     присутствует в `OrderItem`;
 *   - `qty` — целое > 0, по умолчанию 1;
 *   - `routeTemplateId` — опционально (метаинформация);
 *   - `materialMode` — обязателен;
 *   - `countsTowardOrderQty` — boolean, default `false` (MVP).
 */
export const StartOrderSampleSchema = z.object({
  /**
   * Если у заказа несколько `OrderItem` с одним sizeId, но разными
   * productId — нужно явно указать. Иначе backend сам резолвит
   * productId из уникальной (orderId, sizeId) пары.
   */
  productId: z.string().min(1).optional(),
  sizeId: z.string().min(1, 'sizeId обязателен'),
  qty: z
    .number({ invalid_type_error: 'qty должен быть числом' })
    .int('qty должен быть целым')
    .positive('qty должен быть > 0')
    .default(1),
  routeTemplateId: z.string().min(1).optional(),
  materialMode: OrderSampleMaterialModeSchema,
  countsTowardOrderQty: z.boolean().default(false),
  comment: z.string().trim().max(1000, 'comment слишком длинный').optional(),
  /**
   * Раскройщик, на которого пишется immediate-начисление в момент
   * создания sample-passport (тот же контракт, что и у обычного
   * `CreatePassportDto.cutterId`). На MVP — опциональное поле; если
   * не задано, backend применяет ту же fallback-логику, что и
   * `PassportsService.create`: при `role = CUTTER` у инициатора —
   * атрибуция самому себе, иначе 400 `CUTTER_REQUIRED`.
   */
  cutterId: z.string().min(1).optional(),
});
export type StartOrderSampleDto = z.infer<typeof StartOrderSampleSchema>;

export const ApproveOrderSampleSchema = z.object({
  comment: z.string().trim().max(1000).optional(),
});
export type ApproveOrderSampleDto = z.infer<typeof ApproveOrderSampleSchema>;

export const RejectOrderSampleSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Укажите причину отклонения')
    .max(1000, 'Причина слишком длинная'),
});
export type RejectOrderSampleDto = z.infer<typeof RejectOrderSampleSchema>;

export const CancelOrderSampleSchema = z.object({
  comment: z.string().trim().max(1000).optional(),
});
export type CancelOrderSampleDto = z.infer<typeof CancelOrderSampleSchema>;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

export interface OrderSamplePassportLiteDto {
  id: string;
  number: string;
  status: 'CREATED' | 'IN_PROGRESS' | 'PACKED' | 'CANCELLED';
  qtyCut: number;
}

/**
 * Краткая инфо о размере / продукте для UI-строки списка.
 */
export interface OrderSampleSizeLiteDto {
  id: string;
  code: string;
  sortOrder: number;
}

export interface OrderSampleProductLiteDto {
  id: string;
  name: string;
}

export interface OrderSampleRouteLiteDto {
  id: string;
  code: string;
  name: string;
}

/**
 * Эффект образца на тираж. Считается логически (план в БД не
 * мутируется).
 *
 *   - `orderSizeQtyPlan` — `OrderItem.qtyPlan` по выбранному размеру
 *     (snapshot значения на момент чтения).
 *   - `remainingQty` — сколько штук этого размера ещё нужно отшить:
 *     если `countsTowardOrderQty = true` и статус образца `APPROVED`
 *     или `IN_PROGRESS`, `remainingQty = orderSizeQtyPlan − qty`,
 *     иначе `remainingQty = orderSizeQtyPlan`.
 *   - `extraSampleQty` — сколько образцов идёт «сверх тиража»: если
 *     `countsTowardOrderQty = false`, это `qty`, иначе `0`.
 *
 * На MVP не учитываем уже выпущенные тиражные паспорта в
 * `remainingQty` — это derived-поле UI-уровня (PassportsService уже
 * имеет независимый guard `qtyCut > remaining`).
 */
export interface OrderSampleBulkEffectDto {
  sizeId: string;
  sizeCode: string;
  orderSizeQtyPlan: number;
  sampleQty: number;
  countsTowardOrderQty: boolean;
  remainingQty: number;
  extraSampleQty: number;
}

export interface OrderSampleDto {
  id: string;
  orderId: string;
  orderNumber: string;

  product: OrderSampleProductLiteDto;
  size: OrderSampleSizeLiteDto;
  qty: number;

  routeTemplate: OrderSampleRouteLiteDto | null;

  materialMode: OrderSampleMaterialMode;
  countsTowardOrderQty: boolean;

  status: OrderSampleStatus;
  comment: string | null;
  rejectionReason: string | null;

  createdById: string | null;
  approvedById: string | null;
  rejectedById: string | null;

  createdAt: string; // ISO
  approvedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;

  passport: OrderSamplePassportLiteDto | null;
  bulkEffect: OrderSampleBulkEffectDto;
}

export interface OrderSampleListItemDto {
  id: string;
  orderId: string;
  product: OrderSampleProductLiteDto;
  size: OrderSampleSizeLiteDto;
  qty: number;
  materialMode: OrderSampleMaterialMode;
  countsTowardOrderQty: boolean;
  status: OrderSampleStatus;
  createdAt: string;
  approvedAt: string | null;
  passport: OrderSamplePassportLiteDto | null;
  bulkEffect: OrderSampleBulkEffectDto;
}

export type OrderSampleListDto = OrderSampleListItemDto[];

// ---------------------------------------------------------------------------
// Domain error codes (см. apps/api/src/common/errors.ts)
// ---------------------------------------------------------------------------

export const ORDER_SAMPLE_ERROR_CODES = [
  'ORDER_SAMPLE_NOT_FOUND',
  'ORDER_SAMPLE_ALREADY_ACTIVE',
  'ORDER_SAMPLE_INVALID_STATUS',
  'ORDER_SAMPLE_SIZE_NOT_IN_ORDER',
  'ORDER_SAMPLE_ORDER_INVALID_STATUS',
  'ORDER_SAMPLE_QTY_EXCEEDS_ORDER_SIZE_QTY',
  'ORDER_SAMPLE_REJECTION_REASON_REQUIRED',
] as const;
export type OrderSampleErrorCode = (typeof ORDER_SAMPLE_ERROR_CODES)[number];
