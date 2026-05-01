/**
 * Контракты модуля «Ручная отметка поступления материала»
 * (см. `apps/api/src/modules/order-material-arrivals/*`,
 * `apps/api/src/modules/cut-readiness/cut-readiness.service.ts`,
 * `apps/web/components/orders/cut-readiness-card.tsx`,
 * `prisma/schema.prisma::OrderMaterialArrivalOverride`).
 *
 * Назначение:
 *   - дать ADMIN/SHOP_MANAGER кнопку «Материал поступил» в карточке
 *     заказа, которая разблокирует крой, не создавая фиктивную
 *     складскую приёмку;
 *   - `CutReadinessService` учитывает ACTIVE-overrides и считает
 *     материал «готовым» (см. JSDoc сервиса).
 *
 * Дизайн MVP — изолированный override готовности к крою, НЕ
 * складская операция:
 *   - НЕТ изменений `PurchaseReceipt` / `PurchaseReceiptLine`;
 *   - НЕТ изменений `CellContent` / складских остатков;
 *   - НЕТ изменений `WorkshopNeed.status`;
 *   - НЕТ изменений `Order.status`.
 *
 * Override создаётся для конкретной `WorkshopNeed` (или для всех
 * blocking-потребностей заказа сразу, если фронт не передал
 * `workshopNeedIds`). Дубль для одной и той же потребности при
 * повторном POST НЕ создаётся — сервис возвращает уже существующий
 * ACTIVE-override.
 *
 * Отмена ручной отметки — отдельный POST
 * `/api/orders/:id/material-arrival-overrides/:overrideId/revoke`
 * с обязательной причиной (`reason`). После revoke
 * `CutReadinessService` снова показывает строку как блокер, если
 * нет реальной приёмки.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Statuses (свободная строка в БД, валидация Zod)
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл ручной отметки поступления:
 *
 * - `ACTIVE`  — overrides действует, `CutReadinessService` считает
 *               материал по этой `WorkshopNeed` поступившим.
 * - `REVOKED` — override отменён вручную (через revoke-эндпоинт).
 *               `CutReadinessService` его игнорирует.
 *
 * Расширение списка не требует миграции БД — поле хранится TEXT.
 */
export const ORDER_MATERIAL_ARRIVAL_OVERRIDE_STATUSES = [
  'ACTIVE',
  'REVOKED',
] as const;
export type OrderMaterialArrivalOverrideStatus =
  (typeof ORDER_MATERIAL_ARRIVAL_OVERRIDE_STATUSES)[number];

export const OrderMaterialArrivalOverrideStatusSchema = z.enum(
  ORDER_MATERIAL_ARRIVAL_OVERRIDE_STATUSES,
);

export const ORDER_MATERIAL_ARRIVAL_OVERRIDE_STATUS_LABELS: Record<
  OrderMaterialArrivalOverrideStatus,
  string
> = {
  ACTIVE: 'Активна',
  REVOKED: 'Отменена',
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * `POST /api/orders/:id/material-arrived` — создать ручные отметки
 * поступления материала.
 *
 * Поведение сервиса (см.
 * `OrderMaterialArrivalsService.markArrived`):
 *   - если `workshopNeedIds` передан — override создаётся только
 *     для перечисленных строк (после проверки, что они принадлежат
 *     заказу);
 *   - если `workshopNeedIds` отсутствует — override создаётся для
 *     всех blocking-потребностей заказа (см.
 *     `CUT_BLOCKING_MATERIAL_ROLES` в `cut-readiness.ts`);
 *   - дубль для одной и той же потребности (где уже есть ACTIVE
 *     override) НЕ создаётся — сервис возвращает существующую
 *     строку.
 *
 * Комментарий обязателен (`min(2)`) — это сознательная ручная
 * разблокировка, она должна быть объяснена.
 */
export const CreateOrderMaterialArrivalOverrideSchema = z.object({
  workshopNeedIds: z
    .array(
      z
        .string()
        .trim()
        .min(1, 'Идентификатор потребности не может быть пустым')
        .max(64, 'Слишком длинный идентификатор потребности'),
    )
    .max(64, 'Слишком много потребностей в одном запросе')
    .optional(),
  comment: z
    .string()
    .trim()
    .min(2, 'Укажите комментарий (минимум 2 символа)')
    .max(2000, 'Слишком длинный комментарий'),
});
export type CreateOrderMaterialArrivalOverrideDto = z.infer<
  typeof CreateOrderMaterialArrivalOverrideSchema
>;

/**
 * `POST /api/orders/:id/material-arrival-overrides/:overrideId/revoke`
 * — отменить ранее созданный override.
 *
 * Причина обязательна — отмена ручной разблокировки тоже должна
 * быть объяснена (например: «нажали по ошибке», «материал так и
 * не поступил»).
 */
export const RevokeOrderMaterialArrivalOverrideSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(2, 'Укажите причину отмены (минимум 2 символа)')
    .max(2000, 'Слишком длинная причина отмены'),
});
export type RevokeOrderMaterialArrivalOverrideDto = z.infer<
  typeof RevokeOrderMaterialArrivalOverrideSchema
>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

/**
 * Снимок ручной отметки поступления материала.
 *
 * `qty` отдаётся как Decimal-строка (формат
 * `Prisma.Decimal.toString()`), чтобы UI не терял точность при
 * сериализации в JSON. `null` означает «не указано» — в этом
 * случае `CutReadinessService` считает override покрытием
 * `targetQty` для своей `WorkshopNeed`.
 *
 * `createdByName` / `revokedByName` денормализованы в DTO, чтобы
 * UI не дёргал отдельный запрос в справочник сотрудников: имя
 * нужно для бейджа «Кто отметил» в карточке заказа.
 */
export interface OrderMaterialArrivalOverrideDto {
  id: string;
  orderId: string;
  workshopNeedId: string | null;
  materialRole: string | null;
  description: string | null;
  /** Decimal-as-string или number; UI показывает «как есть». */
  qty: string | number | null;
  unit: string | null;
  status: OrderMaterialArrivalOverrideStatus;
  comment: string | null;
  createdById: string | null;
  createdByName: string | null;
  /** ISO-8601, как и во всех остальных API-ответах. */
  createdAt: string;
  revokedAt: string | null;
  revokedById: string | null;
  revokedByName: string | null;
  revokeReason: string | null;
}
