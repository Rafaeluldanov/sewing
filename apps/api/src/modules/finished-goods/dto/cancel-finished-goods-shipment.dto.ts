import { z } from 'zod';

/**
 * DTO для `POST /api/finished-goods/shipments/:id/cancel` —
 * отмена ранее проведённого документа отгрузки готовой продукции
 * (см. `apps/api/src/modules/finished-goods/finished-goods.service.ts::cancelShipment`,
 * `prisma/schema.prisma::FinishedGoodsShipment`,
 * `docs/api.md §«Finished goods shipments»`,
 * `docs/current-state.md §«Отгрузка готовой продукции»`).
 *
 * Контракт:
 *   - `reason` обязателен, 2..500 символов; сохраняется в
 *     `FinishedGoodsShipment.cancelReason`. Это управленческое поле:
 *     причина отмены остаётся в истории и попадает в audit-payload.
 *
 * Намеренно НЕ принимаем:
 *   - `lines` / `qty` / `finishedGoodsBalanceId` — частичная отмена
 *     не поддерживается на этой итерации (см. ТЗ);
 *   - `clientRequestId` — идемпотентность повторного cancel-вызова
 *     достигается проверкой `status === CANCELLED` (см.
 *     `cancelShipment`).
 */
export const CancelFinishedGoodsShipmentSchema = z
  .object({
    reason: z.string().trim().min(2).max(500),
  })
  .strict();

export type CancelFinishedGoodsShipmentDto = z.infer<
  typeof CancelFinishedGoodsShipmentSchema
>;
