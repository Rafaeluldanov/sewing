import { z } from 'zod';

import { WORK_IN_PROGRESS_MOVEMENT_TYPES, WORK_IN_PROGRESS_MOVEMENT_DIRECTIONS } from '../work-in-progress.constants.js';

/**
 * Query DTO для `GET /api/work-in-progress/movements` (read-only).
 */
export const ListWorkInProgressMovementsQuerySchema = z
  .object({
    orderId: z.string().trim().min(1).max(64).optional(),
    passportId: z.string().trim().min(1).max(64).optional(),
    warehouseId: z.string().trim().min(1).max(64).optional(),
    cellId: z.string().trim().min(1).max(64).optional(),
    type: z
      .string()
      .trim()
      .refine(
        (v) => (WORK_IN_PROGRESS_MOVEMENT_TYPES as readonly string[]).includes(v),
        'Неизвестный тип движения полуфабриката',
      )
      .optional(),
    direction: z
      .string()
      .trim()
      .refine(
        (v) =>
          (WORK_IN_PROGRESS_MOVEMENT_DIRECTIONS as readonly string[]).includes(v),
        'Направление должно быть IN или OUT',
      )
      .optional(),
    skip: z.coerce.number().int().min(0).max(1_000_000).optional(),
    take: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export type ListWorkInProgressMovementsQuery = z.infer<
  typeof ListWorkInProgressMovementsQuerySchema
>;
