import { z } from 'zod';

import {
  MATERIAL_ISSUE_RETURN_CLIENT_REQUEST_ID_MAX_LENGTH,
  MATERIAL_ISSUE_RETURN_REASON_MAX_LENGTH,
  MATERIAL_ISSUE_RETURN_REASON_MIN_LENGTH,
} from '@sewing/shared/material-issues';

/**
 * Body DTO для `POST /api/material-issues/:id/return` — полное
 * сторно проведённого `MaterialIssue` (см.
 * `apps/api/src/modules/material-issues/material-issues.service.ts::returnPostedIssue`,
 * `prisma/schema.prisma::MaterialIssueReturn`,
 * `docs/api.md §«Material issues»`).
 *
 * MVP-итерация — UI отдаёт только полное сторно (списки строк
 * формирует сервис на основе `issuedQty − Σ ранее возвращённое`),
 * поэтому body содержит только `reason` и опциональный
 * `clientRequestId` для идемпотентности повторного submit формы.
 */
export const ReturnMaterialIssueSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(MATERIAL_ISSUE_RETURN_REASON_MIN_LENGTH)
      .max(MATERIAL_ISSUE_RETURN_REASON_MAX_LENGTH),
    clientRequestId: z
      .string()
      .trim()
      .min(1)
      .max(MATERIAL_ISSUE_RETURN_CLIENT_REQUEST_ID_MAX_LENGTH)
      .optional(),
  })
  .strict();

export type ReturnMaterialIssueDto = z.infer<typeof ReturnMaterialIssueSchema>;
