/**
 * Контракты модуля «Закрытие раскроя по размеру через заявку» (ADR-0018).
 *
 * Доменная модель: на пару `Order × Product × Size` помощник
 * раскройщика подаёт заявку (`CuttingClosureRequest`), мастер цеха
 * подтверждает или отклоняет её. После `APPROVED` backend (см.
 * `PassportsService.create`) запрещает выпуск новых паспортов по
 * этой строке. См. также `docs/domain.md §15`, `docs/api.md §14`.
 *
 * Zod-схемы — источник истины для валидации запросов API и форм UI.
 * `type`-алиасы выведены из схем, чтобы web и api жили на одних DTO.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Status enum (совпадает с CuttingClosureRequestStatus в Prisma)
// ---------------------------------------------------------------------------

export const CUTTING_CLOSURE_REQUEST_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
] as const;
export const CuttingClosureRequestStatusSchema = z.enum(
  CUTTING_CLOSURE_REQUEST_STATUSES,
);
export type CuttingClosureRequestStatus = z.infer<
  typeof CuttingClosureRequestStatusSchema
>;

export const CUTTING_CLOSURE_REQUEST_STATUS_LABELS: Record<
  CuttingClosureRequestStatus,
  string
> = {
  REQUESTED: 'Заявка отправлена мастеру',
  APPROVED: 'Раскрой закрыт',
  REJECTED: 'Заявка отклонена',
};

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/cutting-close-requests`.
 *
 * - `orderId` / `productId` / `sizeId` — ровно та строка плана, по
 *   которой раскрой объявляется законченным;
 * - `reason` — короткая причина (опционально). На MVP до 280 символов.
 */
export const CreateCuttingClosureRequestSchema = z.object({
  orderId: z.string().min(1, 'orderId обязателен'),
  productId: z.string().min(1, 'productId обязателен'),
  sizeId: z.string().min(1, 'sizeId обязателен'),
  reason: z.string().trim().max(280).optional(),
});
export type CreateCuttingClosureRequestDto = z.infer<
  typeof CreateCuttingClosureRequestSchema
>;

/**
 * Тело `POST /api/cutting-close-requests/:id/reject`. На MVP мастер
 * может приложить короткую заметку — отображается на карточке
 * паспорта, чтобы помощник понимал, почему отказали.
 */
export const ReviewCuttingClosureRequestSchema = z.object({
  note: z.string().trim().max(280).optional(),
});
export type ReviewCuttingClosureRequestDto = z.infer<
  typeof ReviewCuttingClosureRequestSchema
>;

/**
 * Параметры `GET /api/cutting-close-requests`.
 *
 * Фильтры узкие и плоские: статус и/или конкретная строка. Менеджер
 * в карточке заказа/паспорта сам решает, какой срез ему нужен.
 */
export const ListCuttingClosureRequestsQuerySchema = z.object({
  status: CuttingClosureRequestStatusSchema.optional(),
  orderId: z.string().min(1).optional(),
  productId: z.string().min(1).optional(),
  sizeId: z.string().min(1).optional(),
});
export type ListCuttingClosureRequestsQuery = z.infer<
  typeof ListCuttingClosureRequestsQuerySchema
>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

/**
 * Снэпшот плана/факта/остатка по конкретной строке на момент ответа.
 * Считается так же, как в `aggregateOrder`: факт = `Σ passport.qtyCut`
 * по живым (не CANCELLED) паспортам того же размера.
 */
export interface CuttingClosureRequestPlanFactDto {
  qtyPlan: number;
  qtyCut: number;
  qtyRemaining: number;
}

export interface CuttingClosureRequestDto {
  id: string;
  orderId: string;
  orderNumber: string;
  productId: string;
  productName: string;
  sizeId: string;
  sizeCode: string;
  status: CuttingClosureRequestStatus;
  reason: string | null;
  reviewerNote: string | null;
  requestedByEmployeeId: string;
  requestedByEmployeeName: string;
  requestedAt: string; // ISO
  reviewedByEmployeeId: string | null;
  reviewedByEmployeeName: string | null;
  reviewedAt: string | null; // ISO
  /** План/факт/остаток на момент ответа (для UI заявки и решения мастера). */
  planFact: CuttingClosureRequestPlanFactDto;
}
