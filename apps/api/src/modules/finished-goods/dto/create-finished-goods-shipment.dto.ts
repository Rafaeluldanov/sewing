import { z } from 'zod';

/**
 * DTO для `POST /api/orders/:orderId/finished-goods-shipments` —
 * создать документ отгрузки готовой продукции по заказу
 * (см. `apps/api/src/modules/finished-goods/finished-goods.service.ts::createShipmentForOrder`,
 * `prisma/schema.prisma::FinishedGoodsShipment` /
 * `FinishedGoodsShipmentLine`,
 * `docs/api.md §«Finished goods shipments»`).
 *
 * Контракт:
 *   - `lines` — минимум одна строка; каждая — `finishedGoodsBalanceId`
 *     + целое `qty > 0`. Остальное (`productId` / `sizeId` / `color` /
 *     `warehouseId` / `cellId`) сервис достаёт из соответствующего
 *     `FinishedGoodsBalance` и пишет snapshot-ом в строку shipment;
 *   - `shippedAt` опционален, ISO datetime — иначе `now()`;
 *   - `comment` опционален, max 500;
 *   - `clientRequestId` опционален; если не задан, сервис сам
 *     генерирует cuid (но тогда повторный submit под новым ключом не
 *     идемпотентен — UI всегда должен генерировать UUID).
 *
 * Не принимаем:
 *   - `orderId` — берётся из URL (`:orderId`), клиент не может его
 *     переопределить;
 *   - `productId` / `sizeId` / `color` / `warehouseId` / `cellId` —
 *     snapshot-ятся из `FinishedGoodsBalance`;
 *   - `sourceKey` / `balanceBeforeQty` / `balanceAfterQty` — серверные
 *     поля, клиент их не задаёт.
 */
const trimmedString = (max: number) => z.string().trim().min(1).max(max);

export const CreateFinishedGoodsShipmentLineSchema = z
  .object({
    finishedGoodsBalanceId: trimmedString(64),
    qty: z
      .number({ invalid_type_error: 'Количество должно быть числом' })
      .int('Количество должно быть целым')
      .positive('Количество должно быть больше нуля'),
    comment: z.string().trim().max(500).optional(),
  })
  .strict();

export type CreateFinishedGoodsShipmentLineDto = z.infer<
  typeof CreateFinishedGoodsShipmentLineSchema
>;

export const CreateFinishedGoodsShipmentSchema = z
  .object({
    shippedAt: z.string().datetime().optional(),
    comment: z.string().trim().max(500).optional(),
    clientRequestId: trimmedString(128).optional(),
    lines: z
      .array(CreateFinishedGoodsShipmentLineSchema)
      .min(1, 'Нужна хотя бы одна строка отгрузки'),
  })
  .strict();

export type CreateFinishedGoodsShipmentDto = z.infer<
  typeof CreateFinishedGoodsShipmentSchema
>;
