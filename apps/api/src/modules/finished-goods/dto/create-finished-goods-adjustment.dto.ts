import { z } from 'zod';

import {
  FINISHED_GOODS_MOVEMENT_DIRECTION,
  FINISHED_GOODS_MOVEMENT_DIRECTIONS,
} from '../finished-goods.constants.js';

/**
 * Body DTO для `POST /api/finished-goods/adjustments` — ручная
 * корректировка остатка готовой продукции (см.
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts::createAdjustment`,
 * `apps/api/src/modules/finished-goods/finished-goods.controller.ts`,
 * `docs/api.md §«Finished goods adjustments»`).
 *
 * Контракт:
 *   - `finishedGoodsBalanceId` обязателен — корректируем существующий
 *     `FinishedGoodsBalance`. Сервис достаёт из него `orderId`,
 *     `productId`, `sizeId`, `color`, `warehouseId`, `cellId` —
 *     клиент эти поля не присылает.
 *   - `direction` — `IN` (увеличить остаток) или `OUT` (уменьшить).
 *   - `qty` целое положительное (готовая продукция всегда штучная,
 *     `FinishedGoodsBalance.qty: Int`).
 *   - `comment` обязателен, 2..500 символов: причина корректировки
 *     должна оставаться в журнале движений.
 *   - `clientRequestId` опционален; если передан — становится частью
 *     идемпотентного `sourceKey =
 *     FINISHED_GOODS_ADJUSTMENT:<clientRequestId>`. Если не передан —
 *     сервис генерирует UUID server-side, но повторный submit под
 *     новым ключом тогда не идемпотентен (UI всегда обязан
 *     генерировать UUID).
 *
 * Сознательно НЕ принимаем: `orderId`, `productId`, `sizeId`,
 * `color`, `warehouseId`, `cellId`, `unit`, `sourceKey`,
 * `balanceBeforeQty`, `balanceAfterQty`, `createdById`. Эти данные
 * сервис достаёт из исходного `FinishedGoodsBalance` или вычисляет
 * сам.
 */
export const CreateFinishedGoodsAdjustmentSchema = z
  .object({
    finishedGoodsBalanceId: z.string().trim().min(1).max(64),
    direction: z.enum(
      FINISHED_GOODS_MOVEMENT_DIRECTIONS as [string, ...string[]],
    ),
    qty: z
      .number({ invalid_type_error: 'Количество должно быть числом' })
      .int('Количество должно быть целым')
      .positive('Количество должно быть больше нуля'),
    comment: z.string().trim().min(2).max(500),
    clientRequestId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.direction !== FINISHED_GOODS_MOVEMENT_DIRECTION.IN &&
      data.direction !== FINISHED_GOODS_MOVEMENT_DIRECTION.OUT
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['direction'],
        message: 'direction должен быть IN или OUT.',
      });
    }
  });

export type CreateFinishedGoodsAdjustmentDto = z.infer<
  typeof CreateFinishedGoodsAdjustmentSchema
>;
