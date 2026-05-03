import { z } from 'zod';

/**
 * Преобразование `true|1|false|0` → boolean. `z.coerce.boolean()` не
 * подходит — он возвращает `true` для любой непустой строки, включая
 * литерал `"false"`. На URL-query-стрингах нам нужно строгое
 * различение.
 */
const QueryBoolean = z
  .union([z.boolean(), z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
  .transform((v) => v === true || v === 'true' || v === '1');

/**
 * Query DTO для `GET /api/stock/balances` (read-only API).
 *
 * Все фильтры опциональны и склеиваются по AND. Часть из них
 * проксируется напрямую (`workshopNeedId`, `warehouseId`, `cellId`,
 * `materialRole`, `unit`); часть требует вычисления в сервисе:
 *   - `orderId` — через relation `workshopNeed.orderId`;
 *   - `q` — case-insensitive substring по `description` остатка
 *     (без full-text);
 *   - `positiveOnly` / `negativeOnly` / `zeroOnly` — взаимоисключающие
 *     флаги; одновременно допускается максимум один (см.
 *     `.superRefine`). Если передано больше одного — ZodValidationPipe
 *     отдаёт 400 `VALIDATION_ERROR` с сообщением, которое UI может
 *     показать «как есть».
 *
 * Pagination:
 *   - `limit` default 50, max 200, > 0;
 *   - `offset` default 0, >= 0.
 *
 * Сознательно держим Zod-схему в DTO модуля (а не в `@sewing/shared`):
 * read-only API живёт только на стороне backend MVP — frontend на этой
 * итерации схему не использует.
 */
export const ListStockBalancesQuerySchema = z
  .object({
    workshopNeedId: z.string().trim().min(1).max(64).optional(),
    orderId: z.string().trim().min(1).max(64).optional(),
    warehouseId: z.string().trim().min(1).max(64).optional(),
    cellId: z.string().trim().min(1).max(64).optional(),
    materialRole: z.string().trim().min(1).max(64).optional(),
    unit: z.string().trim().min(1).max(32).optional(),
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

export type ListStockBalancesQuery = z.infer<
  typeof ListStockBalancesQuerySchema
>;
