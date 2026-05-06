import { z } from 'zod';

/**
 * Query DTO для `GET /api/finished-goods/movements` (read-only).
 *
 * Все фильтры опциональны и склеиваются по AND. `from`/`to` — ISO-8601
 * datetime, парсятся через `z.string().datetime()`; внутри сервиса
 * конвертируются в `Date`. Pagination: `limit` default 50, max 200;
 * `offset` default 0.
 *
 * Локальные readonly-tuples для `z.enum` (а не `Object.values(...)`
 * из `finished-goods.constants.ts`, который типизируется как
 * `string[]`). Значения должны соответствовать
 * `FINISHED_GOODS_MOVEMENT_TYPE` / `FINISHED_GOODS_MOVEMENT_DIRECTION`.
 */
const FINISHED_GOODS_MOVEMENT_TYPES = [
  'PRODUCTION_RECEIPT',
  'REVERSAL',
  'ADJUSTMENT',
  'SHIPMENT',
  'TRANSFER',
] as const;

const FINISHED_GOODS_MOVEMENT_DIRECTIONS = ['IN', 'OUT'] as const;

export const ListFinishedGoodsMovementsQuerySchema = z
  .object({
    orderId: z.string().trim().min(1).max(64).optional(),
    productId: z.string().trim().min(1).max(64).optional(),
    sizeId: z.string().trim().min(1).max(64).optional(),
    warehouseId: z.string().trim().min(1).max(64).optional(),
    cellId: z.string().trim().min(1).max(64).optional(),
    type: z.enum(FINISHED_GOODS_MOVEMENT_TYPES).optional(),
    direction: z.enum(FINISHED_GOODS_MOVEMENT_DIRECTIONS).optional(),
    passportId: z.string().trim().min(1).max(64).optional(),
    boxId: z.string().trim().min(1).max(64).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export type ListFinishedGoodsMovementsQuery = z.infer<
  typeof ListFinishedGoodsMovementsQuerySchema
>;
