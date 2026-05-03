import { z } from 'zod';

/**
 * Фильтры для `StockService.listBalances`. Все поля опциональны;
 * условия склеиваются через `AND`.
 */
export const ListStockBalancesQuerySchema = z
  .object({
    workshopNeedId: z.string().trim().min(1).max(64).optional(),
    warehouseId: z.string().trim().min(1).max(64).optional(),
    cellId: z.string().trim().min(1).max(64).optional(),
    take: z.coerce.number().int().min(1).max(200).optional(),
    skip: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export type ListStockBalancesQuery = z.infer<
  typeof ListStockBalancesQuerySchema
>;
