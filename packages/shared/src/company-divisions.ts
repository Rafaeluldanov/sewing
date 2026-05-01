/**
 * Контракты модуля «Подразделения компании» (master-справочник
 * подразделений заказа и display screens, см.
 * `docs/domain.md §«Подразделения заказа»`,
 * `docs/erd.md §«CompanyDivision»`).
 *
 * Дизайн сознательно простой:
 *   - один справочник: код (uniq) + имя + комментарий + активность;
 *   - soft-delete: вместо `DELETE` менеджер выставляет `isActive=false`
 *     через PATCH; список по умолчанию возвращает только активных;
 *   - порядок задаётся вручную (`sortOrder`), новые карточки уходят в
 *     конец списка (default `100`).
 *
 * PHASE 1 «CompanyDivision как master-справочник»: на этот справочник
 * ссылаются `Order.companyDivisionId` и
 * `DisplayScreenConfig.companyDivisionId`. Базовые карточки
 * `MARKETPLACE` / `OTHER` (`code` совпадает с legacy
 * `enum OrderDivision`) гарантированно существуют в БД — их
 * upsert-ит миграция `…_link_company_divisions_to_orders` и
 * каждый re-seed (`prisma/seed.ts`, `tests/utils/seed.ts`).
 * Backend синхронизирует `companyDivision.code` ↔ legacy
 * `Order.division` / `DisplayScreenConfig.division` сервисами
 * `OrdersService` / `DisplayScreensService` до PHASE 2.
 *
 * Источник истины — backend (`CompanyDivisionsService` + контроллер).
 *
 * Связанные файлы:
 *   - `prisma/schema.prisma::CompanyDivision`
 *   - `apps/api/src/modules/company-settings/*`
 *   - `apps/web/lib/company-settings-api.ts`
 *   - `apps/web/app/admin/company-settings/*`
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const COMPANY_DIVISION_CODE_MAX_LENGTH = 64;
export const COMPANY_DIVISION_NAME_MAX_LENGTH = 200;
export const COMPANY_DIVISION_DESCRIPTION_MAX_LENGTH = 1000;
export const COMPANY_DIVISION_DEFAULT_SORT_ORDER = 100;

// ---------------------------------------------------------------------------
// Reusable fields
// ---------------------------------------------------------------------------

/**
 * Optional строка с тримом и empty → null preprocess (см. `clients.ts`).
 */
function optionalNullableString(maxLength: number, label: string) {
  return z.preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') return v;
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed;
    },
    z
      .string()
      .max(maxLength, `${label} не длиннее ${maxLength} символов`)
      .nullable()
      .optional(),
  );
}

const CodeRequiredField = z
  .string()
  .trim()
  .min(1, 'Код обязателен')
  .max(
    COMPANY_DIVISION_CODE_MAX_LENGTH,
    `Код не длиннее ${COMPANY_DIVISION_CODE_MAX_LENGTH} символов`,
  )
  .regex(
    /^[A-Z0-9_\-]+$/i,
    'Код может содержать только латинские буквы, цифры, дефис и подчёркивание',
  );

const CodeOptionalField = z
  .string()
  .trim()
  .min(1, 'Код не может быть пустым')
  .max(
    COMPANY_DIVISION_CODE_MAX_LENGTH,
    `Код не длиннее ${COMPANY_DIVISION_CODE_MAX_LENGTH} символов`,
  )
  .regex(
    /^[A-Z0-9_\-]+$/i,
    'Код может содержать только латинские буквы, цифры, дефис и подчёркивание',
  );

const NameRequiredField = z
  .string()
  .trim()
  .min(1, 'Название обязательно')
  .max(
    COMPANY_DIVISION_NAME_MAX_LENGTH,
    `Название не длиннее ${COMPANY_DIVISION_NAME_MAX_LENGTH} символов`,
  );

const NameOptionalField = z
  .string()
  .trim()
  .min(1, 'Название не может быть пустым')
  .max(
    COMPANY_DIVISION_NAME_MAX_LENGTH,
    `Название не длиннее ${COMPANY_DIVISION_NAME_MAX_LENGTH} символов`,
  );

const DescriptionField = optionalNullableString(
  COMPANY_DIVISION_DESCRIPTION_MAX_LENGTH,
  'Описание',
);

const SortOrderField = z
  .number()
  .int('Порядок — целое число')
  .min(0, 'Порядок не может быть отрицательным')
  .max(100000, 'Слишком большой порядок');

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

export const CreateCompanyDivisionSchema = z.object({
  code: CodeRequiredField,
  name: NameRequiredField,
  description: DescriptionField,
  isActive: z.boolean().optional(),
  sortOrder: SortOrderField.optional(),
});
export type CreateCompanyDivisionDto = z.infer<
  typeof CreateCompanyDivisionSchema
>;

export const UpdateCompanyDivisionSchema = z
  .object({
    code: CodeOptionalField.optional(),
    name: NameOptionalField.optional(),
    description: DescriptionField,
    isActive: z.boolean().optional(),
    sortOrder: SortOrderField.optional(),
  })
  .refine(
    (obj) =>
      obj.code !== undefined ||
      obj.name !== undefined ||
      obj.description !== undefined ||
      obj.isActive !== undefined ||
      obj.sortOrder !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateCompanyDivisionDto = z.infer<
  typeof UpdateCompanyDivisionSchema
>;

// ---------------------------------------------------------------------------
// List query DTO
// ---------------------------------------------------------------------------

export const ListCompanyDivisionsQuerySchema = z.object({
  /**
   * `true` — отдавать карточки независимо от `isActive`. По умолчанию
   * (не задан) backend возвращает только `isActive = true`.
   */
  includeInactive: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (typeof v === 'boolean') return v;
      return v === 'true';
    }),
  search: z.string().trim().max(100).optional(),
});
export type ListCompanyDivisionsQuery = z.infer<
  typeof ListCompanyDivisionsQuerySchema
>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface CompanyDivisionDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
