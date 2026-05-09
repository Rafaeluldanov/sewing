import { z } from 'zod';

const QueryBoolean = z
  .union([
    z.boolean(),
    z.literal('true'),
    z.literal('false'),
    z.literal('1'),
    z.literal('0'),
  ])
  .transform((v) => v === true || v === 'true' || v === '1');

/**
 * Query DTO для `GET /api/work-in-progress/balances` (read-only).
 *
 * Все фильтры опциональны и склеиваются по AND. Pagination —
 * `take` default 100, max 500; `skip` default 0.
 */
export const ListWorkInProgressBalancesQuerySchema = z
  .object({
    orderId: z.string().trim().min(1).max(64).optional(),
    productId: z.string().trim().min(1).max(64).optional(),
    sizeId: z.string().trim().min(1).max(64).optional(),
    color: z.string().trim().min(1).max(64).optional(),
    warehouseId: z.string().trim().min(1).max(64).optional(),
    cellId: z.string().trim().min(1).max(64).optional(),
    /** Если `true`, отдаются только балансы с `qty > 0`. */
    nonZero: QueryBoolean.optional(),
    skip: z.coerce.number().int().min(0).max(1_000_000).optional(),
    take: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export type ListWorkInProgressBalancesQuery = z.infer<
  typeof ListWorkInProgressBalancesQuerySchema
>;
