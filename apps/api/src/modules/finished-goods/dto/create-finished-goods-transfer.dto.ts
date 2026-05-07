import { z } from 'zod';

/**
 * Body DTO для `POST /api/finished-goods/transfers` — перемещение
 * готовой продукции между складами / ячейками (см.
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts::createTransfer`,
 * `apps/api/src/modules/finished-goods/finished-goods.controller.ts`,
 * `docs/api.md §«Finished goods transfers»`).
 *
 * Контракт:
 *   - `fromFinishedGoodsBalanceId` обязателен — перемещаем
 *     существующий `FinishedGoodsBalance`. Сервис достаёт из него
 *     `orderId`, `productId`, `sizeId`, `color`, `warehouseId`,
 *     `cellId` — клиент эти поля не присылает.
 *   - `toWarehouseId` / `toCellId` опциональны и nullable. Если передан
 *     `toCellId` — destination `warehouseId` берётся из
 *     `Cell.warehouseId` (с fallback на `toWarehouseId`); иначе
 *     `cellId = null`.
 *   - `qty` целое положительное (готовая продукция всегда штучная,
 *     `FinishedGoodsBalance.qty: Int`).
 *   - `comment` обязателен, 2..500 символов.
 *   - `clientRequestId` опционален; если передан — становится частью
 *     идемпотентных `sourceKey`-ключей
 *     (`FINISHED_GOODS_TRANSFER:<clientRequestId>:OUT/IN`). Если не
 *     передан — сервис генерирует собственный uuid.
 *
 * Сознательно НЕ принимаем: `orderId`, `productId`, `sizeId`, `color`,
 * `unit`, `sourceKey`, `balanceBeforeQty`, `balanceAfterQty`,
 * `createdById`. Эти данные сервис достаёт из исходного
 * `FinishedGoodsBalance` или вычисляет.
 */
export const CreateFinishedGoodsTransferSchema = z
  .object({
    fromFinishedGoodsBalanceId: z.string().trim().min(1).max(64),
    toWarehouseId: z.string().trim().min(1).max(64).nullable().optional(),
    toCellId: z.string().trim().min(1).max(64).nullable().optional(),
    qty: z
      .number({ invalid_type_error: 'Количество должно быть числом' })
      .int('Количество должно быть целым')
      .positive('Количество должно быть больше нуля'),
    comment: z.string().trim().min(2).max(500),
    clientRequestId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type CreateFinishedGoodsTransferDto = z.infer<
  typeof CreateFinishedGoodsTransferSchema
>;
