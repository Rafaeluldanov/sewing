/**
 * Контракты модуля «Клиенты» (управленческий справочник, добавлено
 * вместе с UI `/admin/clients`).
 *
 * Дизайн сознательно простой:
 *   - один справочник, минимум полей: имя + контакты + комментарий;
 *   - soft-delete: вместо `DELETE` менеджер выставляет `isActive=false`
 *     через PATCH; список по умолчанию возвращает только активных;
 *   - уникальность `name` НЕ требуется — у двух разных клиентов вполне
 *     может быть одно и то же человеческое имя.
 *
 * Backend-валидация и веб-формы используют эти Zod-схемы как источник
 * истины (см. `apps/api/src/modules/clients/*`,
 * `apps/web/lib/clients-api.ts`, `apps/web/app/admin/clients/*`).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Reusable fields
// ---------------------------------------------------------------------------

export const CLIENT_NAME_MAX_LENGTH = 200;
export const CLIENT_PHONE_MAX_LENGTH = 64;
export const CLIENT_EMAIL_MAX_LENGTH = 200;
export const CLIENT_COMMENT_MAX_LENGTH = 2000;

const NameRequiredField = z
  .string()
  .trim()
  .min(1, 'Название обязательно')
  .max(
    CLIENT_NAME_MAX_LENGTH,
    `Название не длиннее ${CLIENT_NAME_MAX_LENGTH} символов`,
  );

const NameOptionalField = z
  .string()
  .trim()
  .min(1, 'Название не может быть пустым')
  .max(
    CLIENT_NAME_MAX_LENGTH,
    `Название не длиннее ${CLIENT_NAME_MAX_LENGTH} символов`,
  );

/**
 * Optional строковое поле, которое:
 *   - принимает пустую строку как «не задано» → возвращает `null`;
 *   - триммит пробелы;
 *   - проверяет длину.
 *
 * Используется для phone/email/comment — чтобы веб-форма могла слать
 * пустые `<input>` без явного `null`, и они не превращались в
 * `""` в БД.
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

const PhoneField = optionalNullableString(CLIENT_PHONE_MAX_LENGTH, 'Телефон');
const CommentField = optionalNullableString(
  CLIENT_COMMENT_MAX_LENGTH,
  'Комментарий',
);

/**
 * Email — опциональный, но если задан, должен быть валидным. Принимаем
 * пустую строку как `null` (формы без явной очистки), чтобы менеджер
 * не получал «invalid email» из-за пустого поля.
 */
const EmailField = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  },
  z
    .string()
    .email('Некорректный email')
    .max(
      CLIENT_EMAIL_MAX_LENGTH,
      `Email не длиннее ${CLIENT_EMAIL_MAX_LENGTH} символов`,
    )
    .nullable()
    .optional(),
);

// ---------------------------------------------------------------------------
// Request DTO
// ---------------------------------------------------------------------------

export const CreateClientSchema = z.object({
  name: NameRequiredField,
  phone: PhoneField,
  email: EmailField,
  comment: CommentField,
  isActive: z.boolean().optional(),
});
export type CreateClientDto = z.infer<typeof CreateClientSchema>;

export const UpdateClientSchema = z
  .object({
    name: NameOptionalField.optional(),
    phone: PhoneField,
    email: EmailField,
    comment: CommentField,
    isActive: z.boolean().optional(),
  })
  .refine(
    (obj) =>
      obj.name !== undefined ||
      obj.phone !== undefined ||
      obj.email !== undefined ||
      obj.comment !== undefined ||
      obj.isActive !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateClientDto = z.infer<typeof UpdateClientSchema>;

// ---------------------------------------------------------------------------
// List query DTO
// ---------------------------------------------------------------------------

export const ListClientsQuerySchema = z.object({
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
export type ListClientsQuery = z.infer<typeof ListClientsQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface ClientDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  comment: string | null;
  isActive: boolean;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
