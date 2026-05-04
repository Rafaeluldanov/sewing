import { z } from 'zod';

import {
  STOCK_MOVEMENT_DIRECTION,
  STOCK_MOVEMENT_DIRECTIONS,
} from '../stock.constants.js';

/**
 * Body DTO для `POST /api/stock/adjustments` — ручная корректировка
 * остатка материала (см. `apps/api/src/modules/stock/stock.controller.ts`,
 * `apps/api/src/modules/stock/stock.service.ts::createAdjustment`,
 * `docs/api.md §«26a.3 POST /api/stock/adjustments»`).
 *
 * Контракт MVP-итерации:
 *   - `stockBalanceId` обязателен — корректируем только существующий
 *     `StockBalance`. Создание корректировки по «несуществующему»
 *     `WorkshopNeed` / новому материалу в этой итерации сознательно
 *     не реализуем — это другой UX (заведение материала через приёмку).
 *   - `direction` — `IN` (увеличить остаток) или `OUT` (уменьшить
 *     остаток). Заводим как enum строки, чтобы DTO жил без зависимости
 *     от Prisma-типа.
 *   - `qty` принимаем строкой ИЛИ числом (точно как в
 *     `MaterialIssueLine.issuedQty`). Валидируем, что это положительное
 *     число с конечным значением — сам Decimal-парсинг делает сервис.
 *   - `unitCost` опционален и **используется только при `IN`**. Для
 *     `OUT` поле формально принимаем (UI может прислать сохранённое
 *     значение), но сервис его игнорирует — складская оценка OUT
 *     всегда берётся из текущего `StockBalance.unitCost`
 *     (см. `StockService.applyMovementInTx`, такая же логика, как у
 *     `recordMaterialIssueInTx`). Если при `IN` `unitCost` не передан,
 *     сервис возьмёт текущий `balance.unitCost` или `0`.
 *   - `comment` обязателен, 2..500 символов. Корректировка остатка —
 *     ручное действие, без причины не пишем.
 *   - `clientRequestId` опционален; если передан — становится частью
 *     идемпотентного `StockMovement.sourceKey`
 *     (`STOCK_ADJUSTMENT:<clientRequestId>`). Если не передан — сервис
 *     генерирует значение сам, чтобы `sourceKey` всегда оставался
 *     уникальным (см. `STOCK_MOVEMENT_SOURCE_KEY_PREFIX.STOCK_ADJUSTMENT`).
 *
 * Сознательно НЕ принимаем: `sourceKey`, `totalCost`, `balanceBeforeQty`,
 * `balanceAfterQty`, `createdById` — это служебные поля, которые
 * сервис рассчитывает / проставляет сам.
 */
export const CreateStockAdjustmentSchema = z
  .object({
    stockBalanceId: z.string().trim().min(1).max(64),
    direction: z.enum(STOCK_MOVEMENT_DIRECTIONS as [string, ...string[]]),
    qty: z.union([z.string().trim().min(1), z.number()]),
    unitCost: z.union([z.string().trim().min(1), z.number()]).optional(),
    comment: z.string().trim().min(2).max(500),
    clientRequestId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.direction !== STOCK_MOVEMENT_DIRECTION.IN &&
      data.direction !== STOCK_MOVEMENT_DIRECTION.OUT
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['direction'],
        message: 'direction должен быть IN или OUT.',
      });
    }
  });

export type CreateStockAdjustmentDto = z.infer<
  typeof CreateStockAdjustmentSchema
>;
