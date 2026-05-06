import { z } from 'zod';

/**
 * Преобразование `true|1|false|0` → boolean (см. аналог в
 * `apps/api/src/modules/stock/dto/list-stock-balances.dto.ts`).
 */
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
 * Query DTO для `GET /api/finished-goods/balances` (read-only).
 *
 * Все фильтры опциональны и склеиваются по AND. `q` —
 * case-insensitive substring по `color`. Pagination: `limit` default
 * 50, max 200; `offset` default 0.
 *
 * `positiveOnly` / `zeroOnly` / `negativeOnly` — взаимоисключающие
 * флаги (см. `superRefine`).
 */
export const ListFinishedGoodsBalancesQuerySchema = z
  .object({
    orderId: z.string().trim().min(1).max(64).optional(),
    productId: z.string().trim().min(1).max(64).optional(),
    sizeId: z.string().trim().min(1).max(64).optional(),
    warehouseId: z.string().trim().min(1).max(64).optional(),
    cellId: z.string().trim().min(1).max(64).optional(),
    q: z.string().trim().min(1).max(128).optional(),
    positiveOnly: QueryBoolean.optional(),
    negativeOnly: QueryBoolean.optional(),
    zeroOnly: QueryBoolean.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const flags = [data.positiveOnly, data.negativeOnly, data.zeroOnly].filter(
      (v) => v === true,
    );
    if (flags.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['positiveOnly'],
        message:
          'Фильтры positiveOnly / negativeOnly / zeroOnly взаимоисключающие — выберите один.',
      });
    }
  });

export type ListFinishedGoodsBalancesQuery = z.infer<
  typeof ListFinishedGoodsBalancesQuerySchema
>;
