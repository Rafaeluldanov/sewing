import { z } from 'zod';

/**
 * Фильтры для `StockService.listMovements`.
 */
export const ListStockMovementsQuerySchema = z
  .object({
    workshopNeedId: z.string().trim().min(1).max(64).optional(),
    stockBalanceId: z.string().trim().min(1).max(64).optional(),
    type: z
      .enum(['PURCHASE_RECEIPT', 'MATERIAL_ISSUE', 'ADJUSTMENT', 'REVERSAL'])
      .optional(),
    direction: z.enum(['IN', 'OUT']).optional(),
    take: z.coerce.number().int().min(1).max(200).optional(),
    skip: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export type ListStockMovementsQuery = z.infer<
  typeof ListStockMovementsQuerySchema
>;
