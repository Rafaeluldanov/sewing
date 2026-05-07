import { z } from 'zod';

import {
  MATERIAL_ISSUE_RETURN_CLIENT_REQUEST_ID_MAX_LENGTH,
  MATERIAL_ISSUE_RETURN_REASON_MAX_LENGTH,
  MATERIAL_ISSUE_RETURN_REASON_MIN_LENGTH,
} from '@sewing/shared/material-issues';

/**
 * Decimal-as-string на стороне backend DTO. Тот же контракт, что
 * `packages/shared/src/material-issues.ts::positiveDecimal` — повторяем
 * локально, чтобы не тащить shared-хелперы в API DTO (исторически
 * у нас api/dto и shared/Zod живут как зеркальные определения).
 */
const decimalStringLike = z
  .union([z.string().trim(), z.number()])
  .transform((value) =>
    typeof value === 'number' ? String(value) : value.replace(',', '.'),
  )
  .refine((value) => /^-?\d+(\.\d{1,4})?$/.test(value), {
    message: 'Ожидалось число (формат Decimal)',
  });

const positiveDecimal = decimalStringLike.refine(
  (value) => Number(value) > 0,
  { message: 'Количество должно быть больше нуля' },
);

/**
 * Одна строка частичного возврата.
 *
 * `materialIssueLineId` валидируется по принадлежности к исходному
 * `MaterialIssue` уже в сервисе (`MaterialIssuesService.returnPostedIssue`),
 * потому что Zod не может проверить FK без БД. На уровне Zod —
 * только формат (string 1..64) и `returnedQty > 0`.
 */
export const ReturnMaterialIssueLineSchema = z
  .object({
    materialIssueLineId: z.string().trim().min(1).max(64),
    returnedQty: positiveDecimal,
  })
  .strict();
export type ReturnMaterialIssueLineDto = z.infer<
  typeof ReturnMaterialIssueLineSchema
>;

/**
 * Body DTO для `POST /api/material-issues/:id/return` — возврат
 * проведённого `MaterialIssue` (см.
 * `apps/api/src/modules/material-issues/material-issues.service.ts::returnPostedIssue`,
 * `prisma/schema.prisma::MaterialIssueReturn`,
 * `docs/api.md §«Material issues»`).
 *
 * Два режима:
 *   - **Полное сторно**: `lines` не передан → сервис возвращает весь
 *     оставшийся остаток по всем строкам (исходное MVP-поведение,
 *     оставлено ради обратной совместимости со старыми клиентами).
 *   - **Частичный возврат**: `lines` передан → сервис возвращает
 *     только указанные `materialIssueLineId × returnedQty`. Дубликаты
 *     запрещены (409 на уровне сервиса), `returnedQty` ≤ остатка
 *     по строке (`issuedQty − Σ ранее возвращённое`); иначе 409.
 *
 * `clientRequestId` (UUID от UI) — идемпотентный ключ, попадает в
 * `MaterialIssueReturn.sourceKey` UNIQUE.
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
    lines: z
      .array(ReturnMaterialIssueLineSchema)
      .min(1, 'Нужна хотя бы одна строка возврата')
      .optional(),
  })
  .strict();

export type ReturnMaterialIssueDto = z.infer<typeof ReturnMaterialIssueSchema>;
