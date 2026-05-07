import { z } from 'zod';

/**
 * Body DTO для `POST /api/stock/transfers` — перемещение остатка
 * между складами / ячейками (см.
 * `apps/api/src/modules/stock/stock.controller.ts`,
 * `apps/api/src/modules/stock/stock.service.ts::createTransfer`,
 * `docs/api.md §«26a.4 POST /api/stock/transfers»`).
 *
 * Контракт MVP-итерации:
 *   - `fromStockBalanceId` обязателен — перемещаем существующий
 *     `StockBalance` (источник). `workshopNeedId`, `unit`, `description`,
 *     `materialRole`, `unitCost` сервис берёт из исходного баланса —
 *     клиент их не присылает.
 *   - `toWarehouseId` / `toCellId` опциональны и nullable. Если передан
 *     `toCellId` — destination `warehouseId` берётся из `Cell.warehouseId`
 *     (а если у `Cell.warehouseId` нет — fallback на `toWarehouseId`).
 *     Если `toCellId` не передан — destination `cellId = null`.
 *   - `qty` принимаем строкой ИЛИ числом (тот же контракт, что у
 *     `create-stock-adjustment.dto.ts`). Положительность проверяется
 *     сервисом; в DTO — формальная защита от пустой строки / NaN.
 *   - `comment` обязателен, 2..500 символов: причина перемещения
 *     должна оставаться в журнале движений (попадает в `comment` обоих
 *     движений `OUT` / `IN`).
 *   - `clientRequestId` опционален; если передан — становится частью
 *     идемпотентных `StockMovement.sourceKey`-ключей
 *     (`STOCK_TRANSFER:<clientRequestId>:OUT` /
 *     `STOCK_TRANSFER:<clientRequestId>:IN`). Если не передан — сервис
 *     генерирует собственный uuid, чтобы пара ключей оставалась
 *     уникальной.
 *
 * Сознательно НЕ принимаем: `sourceKey`, `totalCost`, `unitCost`,
 * `balanceBeforeQty`, `balanceAfterQty`, `createdById`, `workshopNeedId`,
 * `unit`. Эти данные сервис рассчитывает / достаёт из исходного
 * `StockBalance`.
 */
export const CreateStockTransferSchema = z
  .object({
    fromStockBalanceId: z.string().trim().min(1).max(64),
    toWarehouseId: z.string().trim().min(1).max(64).nullable().optional(),
    toCellId: z.string().trim().min(1).max(64).nullable().optional(),
    qty: z.union([z.string().trim().min(1), z.number()]),
    comment: z.string().trim().min(2).max(500),
    clientRequestId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type CreateStockTransferDto = z.infer<typeof CreateStockTransferSchema>;
