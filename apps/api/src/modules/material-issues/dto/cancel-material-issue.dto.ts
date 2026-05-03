import { z } from 'zod';

/**
 * Body DTO для `POST /api/material-issues/:id/cancel`. Причина
 * отмены опциональна — кнопка отмены доступна только в DRAFT, и в
 * MVP мы не настаиваем на обязательном комментарии (UI пока не
 * предполагает этого).
 *
 * POSTED-документы отменять в MVP нельзя — это проверяет
 * `MaterialIssuesService.cancel` отдельной 409-кой.
 */
export const CancelMaterialIssueSchema = z
  .object({
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

export type CancelMaterialIssueDto = z.infer<typeof CancelMaterialIssueSchema>;
