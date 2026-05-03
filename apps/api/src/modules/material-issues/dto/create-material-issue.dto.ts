import { z } from 'zod';

/**
 * DTO для `POST /api/material-issues` — создать документ
 * фактического расхода материалов по заказу
 * (см. `apps/api/src/modules/material-issues/material-issues.service.ts`,
 * `prisma/schema.prisma::MaterialIssue` / `MaterialIssueLine`,
 * `docs/api.md §«Material issues»`).
 *
 * Контракт:
 *   - `orderId` — обязателен;
 *   - `passportId` — опционален; если задан, сервис проверяет, что
 *     паспорт принадлежит этому же заказу;
 *   - `lines` — минимум одна строка;
 *   - `issuedQty > 0`, `unitCost >= 0` — оба поля принимаются как
 *     `string | number` (Decimal-формат), Zod-схема преобразует в
 *     строку и валидирует положительность;
 *   - `workshopNeedId` опционален; если задан, сервис проверит, что
 *     потребность принадлежит этому же заказу, и подставит
 *     `description` / `unit` / `materialRole` из `WorkshopNeed`,
 *     если они не пришли явно;
 *   - если `workshopNeedId` НЕ задан, `description` и `unit`
 *     обязательны (валидация в сервисе, чтобы дать осмысленную
 *     422-ку с полем);
 *   - `status` / `totalCost` клиентом не задаются — это server-side
 *     поля (см. service).
 */

/**
 * Decimal-as-string. Принимаем `string | number`, нормализуем к
 * строке через `coerce`, дополнительно валидируем формат
 * (опциональный знак минуса + цифры + опциональная дробная часть).
 * Граничные проверки `> 0` / `>= 0` — отдельные refinement'ы ниже,
 * чтобы не плодить 5 одинаковых helper-ов.
 */
const decimalStringLike = z
  .union([z.string().trim(), z.number()])
  .transform((value) => (typeof value === 'number' ? String(value) : value))
  .refine((value) => /^-?\d+(\.\d+)?$/.test(value), {
    message: 'Ожидалось число (формат Decimal)',
  });

const positiveDecimal = decimalStringLike.refine(
  (value) => Number(value) > 0,
  { message: 'Количество должно быть больше нуля' },
);

const nonNegativeDecimal = decimalStringLike.refine(
  (value) => Number(value) >= 0,
  { message: 'Цена не может быть отрицательной' },
);

const trimmedString = (max: number) => z.string().trim().min(1).max(max);

export const CreateMaterialIssueLineSchema = z
  .object({
    workshopNeedId: trimmedString(64).optional(),
    description: z.string().trim().min(1).max(500).optional(),
    unit: z.string().trim().min(1).max(32).optional(),
    issuedQty: positiveDecimal,
    unitCost: nonNegativeDecimal,
    cellId: trimmedString(64).optional(),
    comment: z.string().trim().max(2000).optional(),
  })
  .strict();

export type CreateMaterialIssueLineDto = z.infer<
  typeof CreateMaterialIssueLineSchema
>;

export const CreateMaterialIssueSchema = z
  .object({
    orderId: trimmedString(64),
    passportId: trimmedString(64).optional(),
    lines: z
      .array(CreateMaterialIssueLineSchema)
      .min(1, 'Нужна хотя бы одна строка'),
  })
  .strict();

export type CreateMaterialIssueDto = z.infer<typeof CreateMaterialIssueSchema>;
