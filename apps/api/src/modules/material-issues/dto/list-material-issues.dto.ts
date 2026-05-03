import { z } from 'zod';

/**
 * Жизненный цикл документа `MaterialIssue` (хранится как `String` в
 * БД, валидируется Zod-ом — расширение списка не требует миграции).
 *
 * - `DRAFT`     — черновик. Можно провести (`POST /:id/post`) или
 *                 отменить (`POST /:id/cancel`).
 * - `POSTED`    — проведён. Менять/отменить нельзя в MVP.
 * - `CANCELLED` — отменён в DRAFT.
 */
export const MATERIAL_ISSUE_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED'] as const;
export type MaterialIssueStatus = (typeof MATERIAL_ISSUE_STATUSES)[number];

export const MaterialIssueStatusSchema = z.enum(MATERIAL_ISSUE_STATUSES);

/**
 * Query DTO для `GET /api/material-issues`. Все фильтры
 * опциональны; на сервисе они склеиваются в `AND` через
 * `Prisma.MaterialIssueWhereInput`. Сортировка — `createdAt desc`
 * (см. сервис).
 */
export const ListMaterialIssuesQuerySchema = z
  .object({
    orderId: z.string().trim().min(1).max(64).optional(),
    passportId: z.string().trim().min(1).max(64).optional(),
    status: MaterialIssueStatusSchema.optional(),
  })
  .strict();

export type ListMaterialIssuesQuery = z.infer<
  typeof ListMaterialIssuesQuerySchema
>;
