/**
 * Контракты модуля «Настройки компании» (singleton-настройки
 * организации, добавлено вместе с UI `/admin/company-settings`).
 *
 * Дизайн сознательно простой:
 *   - singleton-таблица: один заказчик — один набор реквизитов;
 *   - все поля опциональны (`null` = «не задано»), формат
 *     юридических полей валидируется Zod-ом, а не БД;
 *   - в форме не делаем «сохранить только секцию»: PATCH принимает
 *     любое подмножество полей, остальные не трогает (как у
 *     `UpdateClientSchema` / `UpdateEmployeeSchema`);
 *   - empty-string preprocess → `null` (как в `clients.ts`), чтобы
 *     веб-форма могла слать пустые `<input>` без явных `null`.
 *
 * Источник истины — backend (`CompanySettingsService` + контроллер).
 * UI и server actions используют те же схемы для валидации.
 *
 * Связанные файлы:
 *   - `prisma/schema.prisma::CompanySettings`
 *   - `apps/api/src/modules/company-settings/*`
 *   - `apps/web/lib/company-settings-api.ts`
 *   - `apps/web/app/admin/company-settings/*`
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants (длины полей)
// ---------------------------------------------------------------------------

export const COMPANY_SETTINGS_NAME_MAX_LENGTH = 300;
export const COMPANY_SETTINGS_SHORT_NAME_MAX_LENGTH = 120;
export const COMPANY_SETTINGS_ADDRESS_MAX_LENGTH = 500;
export const COMPANY_SETTINGS_PHONE_MAX_LENGTH = 64;
export const COMPANY_SETTINGS_EMAIL_MAX_LENGTH = 200;
export const COMPANY_SETTINGS_PERSON_MAX_LENGTH = 200;
export const COMPANY_SETTINGS_BANK_NAME_MAX_LENGTH = 300;

/**
 * Стабильный `id` единственной строки `CompanySettings`. Совпадает с
 * `@id @default("default")` в Prisma-схеме — фронт никогда не работает
 * с другими id, а backend идемпотентно создаёт строку с этим id, если
 * её ещё нет.
 */
export const COMPANY_SETTINGS_SINGLETON_ID = 'default';

// ---------------------------------------------------------------------------
// Reusable fields
// ---------------------------------------------------------------------------

/**
 * Optional строковое поле, которое:
 *   - принимает пустую строку как «не задано» → возвращает `null`;
 *   - триммит пробелы;
 *   - проверяет длину.
 *
 * Полный аналог `optionalNullableString` в `clients.ts`. Дублируем,
 * чтобы не плодить cross-module зависимости в shared (clients и
 * company-settings — разные блоки админки, общий хелпер вынесем
 * только если появятся ещё кейсы).
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

/**
 * Optional строка, проходящая дополнительную regex-валидацию (только
 * на непустых значениях). Пустая строка → `null` без regex-проверки —
 * иначе менеджер не сможет «снять» некорректно введённый ИНН.
 */
function optionalDigitsField(opts: {
  digits: number | number[];
  label: string;
}) {
  const lengths = Array.isArray(opts.digits) ? opts.digits : [opts.digits];
  const maxLen = Math.max(...lengths);
  const re = new RegExp(`^\\d{${lengths.join('}|\\d{')}}$`);
  const lenLabel = lengths.length === 1
    ? `${lengths[0]} цифр`
    : `${lengths.join(' или ')} цифр`;
  return z.preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') return v;
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed;
    },
    z
      .string()
      .max(maxLen + 8, `${opts.label} слишком длинный`)
      .regex(re, `${opts.label} — должен содержать ${lenLabel}`)
      .nullable()
      .optional(),
  );
}

const LegalNameField = optionalNullableString(
  COMPANY_SETTINGS_NAME_MAX_LENGTH,
  'Полное название',
);
const ShortNameField = optionalNullableString(
  COMPANY_SETTINGS_SHORT_NAME_MAX_LENGTH,
  'Краткое название',
);

/** ИНН: 10 (юрлица) или 12 цифр (ИП). */
const InnField = optionalDigitsField({ digits: [10, 12], label: 'ИНН' });
/** КПП: 9 цифр (только для юрлиц; пусто допустимо, в т.ч. для ИП). */
const KppField = optionalDigitsField({ digits: 9, label: 'КПП' });
/** ОГРН/ОГРНИП: 13 или 15 цифр. */
const OgrnField = optionalDigitsField({ digits: [13, 15], label: 'ОГРН' });

const LegalAddressField = optionalNullableString(
  COMPANY_SETTINGS_ADDRESS_MAX_LENGTH,
  'Юридический адрес',
);
const ActualAddressField = optionalNullableString(
  COMPANY_SETTINGS_ADDRESS_MAX_LENGTH,
  'Фактический адрес',
);

const PhoneField = optionalNullableString(
  COMPANY_SETTINGS_PHONE_MAX_LENGTH,
  'Телефон',
);

/**
 * Email — опциональный, но если задан, должен быть валидным. Пустая
 * строка трактуется как `null` (та же мягкая семантика, что в
 * `clients.ts::EmailField`).
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
      COMPANY_SETTINGS_EMAIL_MAX_LENGTH,
      `Email не длиннее ${COMPANY_SETTINGS_EMAIL_MAX_LENGTH} символов`,
    )
    .nullable()
    .optional(),
);

const DirectorNameField = optionalNullableString(
  COMPANY_SETTINGS_PERSON_MAX_LENGTH,
  'ФИО руководителя',
);
const AccountantNameField = optionalNullableString(
  COMPANY_SETTINGS_PERSON_MAX_LENGTH,
  'ФИО главного бухгалтера',
);

const BankNameField = optionalNullableString(
  COMPANY_SETTINGS_BANK_NAME_MAX_LENGTH,
  'Название банка',
);
const BikField = optionalDigitsField({ digits: 9, label: 'БИК' });
const SettlementAccountField = optionalDigitsField({
  digits: 20,
  label: 'Расчётный счёт',
});
const CorrespondentAccountField = optionalDigitsField({
  digits: 20,
  label: 'Корреспондентский счёт',
});

/**
 * Boolean-флаги блока «Материалы и склад». На уровне Zod — просто
 * `z.boolean().optional()`: `undefined` ⇒ backend поле не трогает,
 * `true/false` ⇒ применяет значение. Дефолты лежат в Prisma
 * (`autoIssueMaterialsOnCutRelease @default(false)`,
 * `allowNegativeMaterialStock @default(true)`) и читаются backend-ом
 * через приватные геттеры при отсутствии singleton-строки — здесь их
 * не дублируем, чтобы не было двух источников истины.
 */
const AutoIssueMaterialsOnCutReleaseField = z.boolean().optional();
const AllowNegativeMaterialStockField = z.boolean().optional();

// ---------------------------------------------------------------------------
// Update DTO
// ---------------------------------------------------------------------------

export const UpdateCompanySettingsSchema = z
  .object({
    legalName: LegalNameField,
    shortName: ShortNameField,
    inn: InnField,
    kpp: KppField,
    ogrn: OgrnField,
    legalAddress: LegalAddressField,
    actualAddress: ActualAddressField,
    phone: PhoneField,
    email: EmailField,
    directorName: DirectorNameField,
    accountantName: AccountantNameField,
    bankName: BankNameField,
    bik: BikField,
    correspondentAccount: CorrespondentAccountField,
    settlementAccount: SettlementAccountField,
    autoIssueMaterialsOnCutRelease: AutoIssueMaterialsOnCutReleaseField,
    allowNegativeMaterialStock: AllowNegativeMaterialStockField,
  })
  .refine(
    (obj) => Object.values(obj).some((v) => v !== undefined),
    'Нечего обновлять: укажите хотя бы одно поле',
  );

export type UpdateCompanySettingsDto = z.infer<
  typeof UpdateCompanySettingsSchema
>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

export interface CompanySettingsDto {
  id: string;
  legalName: string | null;
  shortName: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  legalAddress: string | null;
  actualAddress: string | null;
  phone: string | null;
  email: string | null;
  directorName: string | null;
  accountantName: string | null;
  bankName: string | null;
  bik: string | null;
  correspondentAccount: string | null;
  settlementAccount: string | null;
  /**
   * Блок «Материалы и склад» / UI `/admin/company-settings`.
   * Если singleton-строки ещё нет, backend отдаёт дефолт
   * (см. `CompanySettingsService.get` fallback):
   *   - `autoIssueMaterialsOnCutRelease = false`
   *   - `allowNegativeMaterialStock    = true`.
   */
  autoIssueMaterialsOnCutRelease: boolean;
  allowNegativeMaterialStock: boolean;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
