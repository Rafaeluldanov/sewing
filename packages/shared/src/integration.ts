/**
 * Контракты модуля «Интеграции» — связь швейного ERP с внешним ERP
 * upgifts (erp.upgifts.ru). Полный дизайн — `docs/upgifts-integration.md`.
 *
 * Фаза 1 (этот файл): singleton-настройки подключения к upgifts +
 * контракт «проверить соединение». Пароль сервисного аккаунта наружу
 * НИКОГДА не отдаётся: в DTO есть только флаг `hasPassword`, а сам
 * секрет хранится в БД зашифрованным (AES-GCM, см.
 * `apps/api/src/modules/integrations/secret-box.ts`).
 *
 * Дизайн (как у `company-settings.ts`):
 *   - singleton-таблица: один тенант — одна связка с upgifts;
 *   - PATCH принимает любое подмножество полей (`undefined` ⇒ не
 *     трогаем; для строк `null`/'' ⇒ очищаем);
 *   - пароль — особый случай: '' / отсутствие ⇒ «не менять» (чтобы
 *     форму можно было пересохранять, не вводя пароль заново);
 *   - валидация «полноты» для включения (`upgiftsEnabled = true`
 *     требует baseUrl+tenant+email+password) живёт в сервисе, не в Zod.
 *
 * Источник истины — backend (`IntegrationsService` + контроллер).
 *
 * Связанные файлы:
 *   - `prisma/schema.prisma::IntegrationSettings`
 *   - `apps/api/src/modules/integrations/*`
 *   - `apps/web/lib/integration-api.ts`
 *   - `apps/web/app/admin/company-settings/integrations-section.tsx`
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INTEGRATION_SETTINGS_SINGLETON_ID = 'default';

export const INTEGRATION_BASE_URL_MAX_LENGTH = 500;
export const INTEGRATION_TENANT_MAX_LENGTH = 200;
export const INTEGRATION_EMAIL_MAX_LENGTH = 200;
export const INTEGRATION_PASSWORD_MAX_LENGTH = 300;
export const INTEGRATION_ORG_ID_MAX_LENGTH = 100;

// ---------------------------------------------------------------------------
// Reusable fields (мягкая семантика '' → null, как в company-settings.ts)
// ---------------------------------------------------------------------------

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

/**
 * Base URL upgifts. Пустая строка ⇒ `null` (очистить); непустая ⇒
 * должна быть валидным http(s)-URL. Храним без завершающего слэша —
 * нормализацию делает сервис.
 */
const BaseUrlField = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  },
  z
    .string()
    .url('Base URL должен быть корректным http(s)-адресом')
    .max(
      INTEGRATION_BASE_URL_MAX_LENGTH,
      `Base URL не длиннее ${INTEGRATION_BASE_URL_MAX_LENGTH} символов`,
    )
    .nullable()
    .optional(),
);

const EmailField = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  },
  z
    .string()
    .email('Некорректный email сервисного аккаунта')
    .max(INTEGRATION_EMAIL_MAX_LENGTH)
    .nullable()
    .optional(),
);

/**
 * Пароль сервисного аккаунта. Особая семантика: '' / отсутствие ⇒
 * `undefined` («не менять»), непустое ⇒ новое значение. Явного «очистить
 * пароль» в v1 нет — для отключения интеграции достаточно
 * `upgiftsEnabled = false`.
 */
const PasswordField = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim();
    return trimmed === '' ? undefined : trimmed;
  },
  z
    .string()
    .max(
      INTEGRATION_PASSWORD_MAX_LENGTH,
      `Пароль не длиннее ${INTEGRATION_PASSWORD_MAX_LENGTH} символов`,
    )
    .optional(),
);

// ---------------------------------------------------------------------------
// Update DTO
// ---------------------------------------------------------------------------

export const UpdateIntegrationSettingsSchema = z
  .object({
    upgiftsEnabled: z.boolean().optional(),
    upgiftsBaseUrl: BaseUrlField,
    upgiftsTenant: optionalNullableString(
      INTEGRATION_TENANT_MAX_LENGTH,
      'Идентификатор тенанта upgifts',
    ),
    upgiftsEmail: EmailField,
    upgiftsPassword: PasswordField,
    upgiftsOrganizationId: optionalNullableString(
      INTEGRATION_ORG_ID_MAX_LENGTH,
      'organization_id',
    ),
  })
  .refine(
    (obj) => Object.values(obj).some((v) => v !== undefined),
    'Нечего обновлять: укажите хотя бы одно поле',
  );

export type UpdateIntegrationSettingsDto = z.infer<
  typeof UpdateIntegrationSettingsSchema
>;

// ---------------------------------------------------------------------------
// Response DTO (пароль НИКОГДА не отдаём — только hasPassword)
// ---------------------------------------------------------------------------

export interface IntegrationSettingsDto {
  id: string;
  upgiftsEnabled: boolean;
  upgiftsBaseUrl: string | null;
  upgiftsTenant: string | null;
  upgiftsEmail: string | null;
  upgiftsOrganizationId: string | null;
  /** Флаг «пароль сервисного аккаунта задан» — сам секрет не отдаём. */
  hasPassword: boolean;
  /** Итог последней успешной проверки соединения (ISO) или null. */
  lastConnectionOkAt: string | null;
  /** Текст последней ошибки соединения (или null, если последняя проверка ок). */
  lastConnectionError: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

// ---------------------------------------------------------------------------
// Test connection contract
// ---------------------------------------------------------------------------

/**
 * Результат `POST /api/integrations/upgifts/test-connection`.
 * Никогда не бросает 5xx из-за недоступности upgifts — ошибки
 * возвращаются как `{ ok: false, message }`, чтобы UI показал их
 * в форме, а не «упал».
 */
export interface UpgiftsTestConnectionResult {
  ok: boolean;
  /** Человекочитаемое сообщение (успех или причина ошибки). */
  message: string;
  /** При успехе — краткий principal из `GET /auth/me`. */
  principal?: {
    tenantId: string | null;
    userId: string | null;
    scopesCount: number;
  };
}
