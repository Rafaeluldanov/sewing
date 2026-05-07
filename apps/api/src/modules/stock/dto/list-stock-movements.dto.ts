import { z } from 'zod';

/**
 * Query DTO для `GET /api/stock/movements` (read-only API).
 *
 * Все фильтры опциональны и склеиваются по AND. Семантика:
 *   - `orderId` — через relation `workshopNeed.orderId`;
 *   - `direction` ∈ `IN | OUT`;
 *   - `type` ∈ `PURCHASE_RECEIPT | MATERIAL_ISSUE | ADJUSTMENT |
 *     REVERSAL | TRANSFER` (см. `stock.constants.ts`);
 *   - `from` / `to` — ISO-строки даты/времени; парсятся `Zod.datetime()`
 *     для UTC; внутри сервиса конвертируются в `Date`;
 *   - `q` — case-insensitive substring по `comment` движения
 *     (без full-text).
 *
 * Pagination:
 *   - `limit` default 50, max 200, > 0;
 *   - `offset` default 0, >= 0.
 *
 * Локальные readonly-tuples для `z.enum` (а не `Object.values(...)`
 * из `stock.constants.ts`, который типизируется как `string[]`).
 * Значения должны соответствовать `STOCK_MOVEMENT_TYPE` и
 * `STOCK_MOVEMENT_DIRECTION` в `../stock.constants.ts`.
 */
const STOCK_MOVEMENT_TYPES = [
  'PURCHASE_RECEIPT',
  'MATERIAL_ISSUE',
  'ADJUSTMENT',
  'REVERSAL',
  'TRANSFER',
] as const;

const STOCK_MOVEMENT_DIRECTIONS = ['IN', 'OUT'] as const;

export const ListStockMovementsQuerySchema = z
  .object({
    workshopNeedId: z.string().trim().min(1).max(64).optional(),
    orderId: z.string().trim().min(1).max(64).optional(),
    stockBalanceId: z.string().trim().min(1).max(64).optional(),
    warehouseId: z.string().trim().min(1).max(64).optional(),
    cellId: z.string().trim().min(1).max(64).optional(),
    type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
    direction: z.enum(STOCK_MOVEMENT_DIRECTIONS).optional(),
    sourceType: z.string().trim().min(1).max(64).optional(),
    sourceId: z.string().trim().min(1).max(64).optional(),
    purchaseReceiptId: z.string().trim().min(1).max(64).optional(),
    purchaseReceiptLineId: z.string().trim().min(1).max(64).optional(),
    materialIssueId: z.string().trim().min(1).max(64).optional(),
    materialIssueLineId: z.string().trim().min(1).max(64).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    q: z.string().trim().min(1).max(128).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export type ListStockMovementsQuery = z.infer<
  typeof ListStockMovementsQuerySchema
>;
