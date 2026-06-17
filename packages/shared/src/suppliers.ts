/**
 * Контракты модуля «Поставщики» (Этап 5, см.
 * `docs/recon-soft-integration.md §«Этап 5»`,
 * `prisma/schema.prisma::Supplier`,
 * `apps/api/src/modules/suppliers/*`).
 *
 * Дизайн MVP:
 *   - закупщик НЕ имеет своей роли: используем существующие
 *     `ADMIN`/`SHOP_MANAGER`;
 *   - справочник изолирован от закупочного контура (нет PurchaseOrder,
 *     нет приёмки, нет складских остатков) — это сознательная граница
 *     этапа 5;
 *   - связь с `WorkshopNeed` мягкая: текстовые `supplierNameText` /
 *     `purchaseItemNameText` остаются, пока справочник пуст; UI и
 *     backend читают `selectedSupplier?.name` → `supplierNameText`
 *     (см. `WorkshopNeedDto.selectedSupplierName`);
 *   - `status` хранится как свободная строка в БД, валидация Zod-ом
 *     по `SUPPLIER_STATUSES` (расширение списка не требует миграции).
 *
 * Контракт типов источник истины для:
 *   - backend (Nest controllers/services) валидирует через
 *     ZodValidationPipe;
 *   - frontend (RSC + server actions) использует те же схемы при
 *     отправке форм.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Statuses (свободные строки в БД, валидация Zod)
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл карточки поставщика:
 *
 * - `ACTIVE`   — поставщик доступен для выбора в `WorkshopNeed`;
 * - `INACTIVE` — soft-delete: карточка остаётся в архиве, но в селекте
 *   `WorkshopNeed` не появляется. Backend дополнительно блокирует
 *   привязку (`SUPPLIER_INACTIVE`).
 *
 * Расширение списка (например, `BLOCKED`) сводится к добавлению
 * значения сюда + лейбла в `SUPPLIER_STATUS_LABELS`, без миграции БД.
 */
export const SUPPLIER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];
export const SupplierStatusSchema = z.enum(SUPPLIER_STATUSES);

export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = {
  ACTIVE: 'Активен',
  INACTIVE: 'Неактивен',
};

/**
 * Жизненный цикл позиции каталога поставщика. То же самое, что у
 * `SupplierStatus`, держим отдельный массив, чтобы потом независимо
 * расширять (например, ввести `OUT_OF_STOCK`).
 */
export const SUPPLIER_CATALOG_ITEM_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type SupplierCatalogItemStatus =
  (typeof SUPPLIER_CATALOG_ITEM_STATUSES)[number];
export const SupplierCatalogItemStatusSchema = z.enum(
  SUPPLIER_CATALOG_ITEM_STATUSES,
);

export const SUPPLIER_CATALOG_ITEM_STATUS_LABELS: Record<
  SupplierCatalogItemStatus,
  string
> = {
  ACTIVE: 'Активна',
  INACTIVE: 'В архиве',
};

// ---------------------------------------------------------------------------
// Field constraints
// ---------------------------------------------------------------------------

export const SUPPLIER_NAME_MAX_LENGTH = 200;
export const SUPPLIER_PHONE_MAX_LENGTH = 64;
export const SUPPLIER_WEBSITE_MAX_LENGTH = 300;
export const SUPPLIER_ADDRESS_MAX_LENGTH = 500;
export const SUPPLIER_COMMENT_MAX_LENGTH = 2000;

/**
 * Банковские/платёжные реквизиты (используются заявками на оплату, см.
 * `@sewing/shared/supplier-payment-requests`). Свободные строки без
 * форматных проверок на MVP.
 */
export const SUPPLIER_LEGAL_NAME_MAX_LENGTH = 300;
export const SUPPLIER_INN_MAX_LENGTH = 32;
export const SUPPLIER_KPP_MAX_LENGTH = 32;
export const SUPPLIER_BANK_NAME_MAX_LENGTH = 300;
export const SUPPLIER_BANK_ACCOUNT_MAX_LENGTH = 64;
export const SUPPLIER_BANK_BIK_MAX_LENGTH = 32;
export const SUPPLIER_BANK_CORR_ACCOUNT_MAX_LENGTH = 64;

export const SUPPLIER_CONTACT_NAME_MAX_LENGTH = 200;
export const SUPPLIER_CONTACT_POSITION_MAX_LENGTH = 200;
export const SUPPLIER_CONTACT_EMAIL_MAX_LENGTH = 200;
export const SUPPLIER_CONTACT_MESSENGER_MAX_LENGTH = 200;
export const SUPPLIER_CONTACT_COMMENT_MAX_LENGTH = 2000;

export const SUPPLIER_CATALOG_NAME_MAX_LENGTH = 300;
export const SUPPLIER_CATALOG_ARTICLE_MAX_LENGTH = 200;
export const SUPPLIER_CATALOG_CATEGORY_MAX_LENGTH = 200;
export const SUPPLIER_CATALOG_FABRIC_TYPE_MAX_LENGTH = 200;
export const SUPPLIER_CATALOG_COLOR_MAX_LENGTH = 200;
export const SUPPLIER_CATALOG_UNIT_MAX_LENGTH = 32;
export const SUPPLIER_CATALOG_CURRENCY_MAX_LENGTH = 16;
export const SUPPLIER_CATALOG_COMMENT_MAX_LENGTH = 2000;

/**
 * Sanity-предел для денежных полей. То же значение, что и в
 * `@sewing/shared/workshop-needs::WORKSHOP_NEED_PRICE_MAX`, чтобы UI
 * был согласован.
 */
export const SUPPLIER_PRICE_MAX = 1_000_000_000;
/** Sanity-предел для количеств (`minOrderQty`). */
export const SUPPLIER_QTY_MAX = 1_000_000_000;

// ---------------------------------------------------------------------------
// Reusable Zod helpers
// ---------------------------------------------------------------------------

/**
 * Optional строка, нормализуется в `null` для пустых/whitespace-only.
 * Backend получает либо `null`, либо непустой trimmed текст.
 */
function optionalNullableText(maxLength: number, label: string) {
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
 * Email — опциональный, пустую строку нормализует в `null`. Если не
 * пустой — должен пройти RFC-валидацию Zod.
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
      SUPPLIER_CONTACT_EMAIL_MAX_LENGTH,
      `Email не длиннее ${SUPPLIER_CONTACT_EMAIL_MAX_LENGTH} символов`,
    )
    .nullable()
    .optional(),
);

/**
 * Decimal-поле с не более чем `decimals` знаками после точки и
 * sanity-пределом `max`. `min`-флажок: либо `>= 0`, либо `> 0`. Принимает
 * `string | number | null | undefined`. Возвращает строку (Prisma.Decimal
 * принимает её как есть) или `null` (стирание поля) или `undefined`
 * (поле в форме не передано — backend оставит как было).
 */
function decimalField({
  decimals,
  max,
  min,
  label,
}: {
  decimals: number;
  max: number;
  min: 'gtZero' | 'geZero';
  label: string;
}) {
  return z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v, ctx): string | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const raw =
        typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
      if (raw === '') return null;
      const re = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
      if (!re.test(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: число, не более ${decimals} знаков после точки`,
        });
        return z.NEVER;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: некорректное значение`,
        });
        return z.NEVER;
      }
      if (min === 'gtZero' && n <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} должно быть > 0`,
        });
        return z.NEVER;
      }
      if (min === 'geZero' && n < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} должно быть >= 0`,
        });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: значение выглядит ошибочным`,
        });
        return z.NEVER;
      }
      return raw;
    }) as unknown as z.ZodType<string | null | undefined>;
}

const LastPriceField = decimalField({
  decimals: 2,
  max: SUPPLIER_PRICE_MAX,
  min: 'geZero',
  label: 'Цена',
});

const MinOrderQtyField = decimalField({
  decimals: 4,
  max: SUPPLIER_QTY_MAX,
  min: 'gtZero',
  label: 'Минимальная партия',
});

/**
 * Положительное целое (для `densityGsm`/`deliveryDays`). Пустую строку /
 * `null` нормализует в `null`. Возвращает либо `number`, либо `null`,
 * либо `undefined` (поля нет в форме).
 */
function positiveIntField({
  min,
  max,
  label,
}: {
  min: 'gtZero' | 'geZero';
  max: number;
  label: string;
}) {
  return z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v, ctx): number | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const raw = typeof v === 'number' ? String(v) : v.trim();
      if (raw === '') return null;
      if (!/^\d+$/.test(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: целое число`,
        });
        return z.NEVER;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: некорректное значение`,
        });
        return z.NEVER;
      }
      if (min === 'gtZero' && n <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} должно быть > 0`,
        });
        return z.NEVER;
      }
      if (min === 'geZero' && n < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} должно быть >= 0`,
        });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: значение выглядит ошибочным`,
        });
        return z.NEVER;
      }
      return n;
    }) as unknown as z.ZodType<number | null | undefined>;
}

const DensityGsmField = positiveIntField({
  min: 'gtZero',
  max: 100_000,
  label: 'Плотность',
});

const DeliveryDaysField = positiveIntField({
  min: 'geZero',
  max: 3650,
  label: 'Срок поставки',
});

// ---------------------------------------------------------------------------
// Supplier — base fields
// ---------------------------------------------------------------------------

const SupplierNameRequired = z
  .string()
  .trim()
  .min(1, 'Название обязательно')
  .max(
    SUPPLIER_NAME_MAX_LENGTH,
    `Название не длиннее ${SUPPLIER_NAME_MAX_LENGTH} символов`,
  );
const SupplierNameOptional = z
  .string()
  .trim()
  .min(1, 'Название не может быть пустым')
  .max(
    SUPPLIER_NAME_MAX_LENGTH,
    `Название не длиннее ${SUPPLIER_NAME_MAX_LENGTH} символов`,
  );

const SupplierPhoneField = optionalNullableText(
  SUPPLIER_PHONE_MAX_LENGTH,
  'Телефон',
);
const SupplierWebsiteField = optionalNullableText(
  SUPPLIER_WEBSITE_MAX_LENGTH,
  'Сайт',
);
const SupplierAddressField = optionalNullableText(
  SUPPLIER_ADDRESS_MAX_LENGTH,
  'Адрес',
);
const SupplierCommentField = optionalNullableText(
  SUPPLIER_COMMENT_MAX_LENGTH,
  'Комментарий',
);

const SupplierLegalNameField = optionalNullableText(
  SUPPLIER_LEGAL_NAME_MAX_LENGTH,
  'Юр. название',
);
const SupplierInnField = optionalNullableText(SUPPLIER_INN_MAX_LENGTH, 'ИНН');
const SupplierKppField = optionalNullableText(SUPPLIER_KPP_MAX_LENGTH, 'КПП');
const SupplierBankNameField = optionalNullableText(
  SUPPLIER_BANK_NAME_MAX_LENGTH,
  'Банк',
);
const SupplierBankAccountField = optionalNullableText(
  SUPPLIER_BANK_ACCOUNT_MAX_LENGTH,
  'Расчётный счёт',
);
const SupplierBankBikField = optionalNullableText(
  SUPPLIER_BANK_BIK_MAX_LENGTH,
  'БИК',
);
const SupplierBankCorrAccountField = optionalNullableText(
  SUPPLIER_BANK_CORR_ACCOUNT_MAX_LENGTH,
  'Корр. счёт',
);

// ---------------------------------------------------------------------------
// Supplier list query
// ---------------------------------------------------------------------------

export const ListSuppliersQuerySchema = z.object({
  /**
   * Поиск по `name` / `phone` / `website` (case-insensitive `contains`).
   * См. `SuppliersService.list`.
   */
  search: z.string().trim().max(120).optional(),
  /**
   * Фильтр по статусу. Без значения — отдаём поставщиков всех статусов
   * (UI таблицы /admin/suppliers сама раскладывает по табам).
   */
  status: SupplierStatusSchema.optional(),
});
export type ListSuppliersQuery = z.infer<typeof ListSuppliersQuerySchema>;

// ---------------------------------------------------------------------------
// Supplier — Create / Update
// ---------------------------------------------------------------------------

export const CreateSupplierSchema = z.object({
  name: SupplierNameRequired,
  phone: SupplierPhoneField,
  website: SupplierWebsiteField,
  address: SupplierAddressField,
  comment: SupplierCommentField,
  legalName: SupplierLegalNameField,
  inn: SupplierInnField,
  kpp: SupplierKppField,
  bankName: SupplierBankNameField,
  bankAccount: SupplierBankAccountField,
  bankBik: SupplierBankBikField,
  bankCorrAccount: SupplierBankCorrAccountField,
  status: SupplierStatusSchema.optional(),
});
export type CreateSupplierDto = z.infer<typeof CreateSupplierSchema>;

export const UpdateSupplierSchema = z
  .object({
    name: SupplierNameOptional.optional(),
    phone: SupplierPhoneField,
    website: SupplierWebsiteField,
    address: SupplierAddressField,
    comment: SupplierCommentField,
    legalName: SupplierLegalNameField,
    inn: SupplierInnField,
    kpp: SupplierKppField,
    bankName: SupplierBankNameField,
    bankAccount: SupplierBankAccountField,
    bankBik: SupplierBankBikField,
    bankCorrAccount: SupplierBankCorrAccountField,
    status: SupplierStatusSchema.optional(),
  })
  .refine(
    (obj) =>
      obj.name !== undefined ||
      obj.phone !== undefined ||
      obj.website !== undefined ||
      obj.address !== undefined ||
      obj.comment !== undefined ||
      obj.legalName !== undefined ||
      obj.inn !== undefined ||
      obj.kpp !== undefined ||
      obj.bankName !== undefined ||
      obj.bankAccount !== undefined ||
      obj.bankBik !== undefined ||
      obj.bankCorrAccount !== undefined ||
      obj.status !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateSupplierDto = z.infer<typeof UpdateSupplierSchema>;

// ---------------------------------------------------------------------------
// SupplierContact — Create / Update
// ---------------------------------------------------------------------------

const ContactNameRequired = z
  .string()
  .trim()
  .min(1, 'Имя контакта обязательно')
  .max(
    SUPPLIER_CONTACT_NAME_MAX_LENGTH,
    `Имя не длиннее ${SUPPLIER_CONTACT_NAME_MAX_LENGTH} символов`,
  );
const ContactNameOptional = z
  .string()
  .trim()
  .min(1, 'Имя контакта не может быть пустым')
  .max(
    SUPPLIER_CONTACT_NAME_MAX_LENGTH,
    `Имя не длиннее ${SUPPLIER_CONTACT_NAME_MAX_LENGTH} символов`,
  );

const ContactPositionField = optionalNullableText(
  SUPPLIER_CONTACT_POSITION_MAX_LENGTH,
  'Должность',
);
const ContactPhoneField = optionalNullableText(
  SUPPLIER_PHONE_MAX_LENGTH,
  'Телефон',
);
const ContactMessengerField = optionalNullableText(
  SUPPLIER_CONTACT_MESSENGER_MAX_LENGTH,
  'Мессенджер',
);
const ContactCommentField = optionalNullableText(
  SUPPLIER_CONTACT_COMMENT_MAX_LENGTH,
  'Комментарий',
);

export const CreateSupplierContactSchema = z.object({
  name: ContactNameRequired,
  position: ContactPositionField,
  phone: ContactPhoneField,
  email: EmailField,
  messenger: ContactMessengerField,
  isPrimary: z.boolean().optional(),
  comment: ContactCommentField,
});
export type CreateSupplierContactDto = z.infer<
  typeof CreateSupplierContactSchema
>;

export const UpdateSupplierContactSchema = z
  .object({
    name: ContactNameOptional.optional(),
    position: ContactPositionField,
    phone: ContactPhoneField,
    email: EmailField,
    messenger: ContactMessengerField,
    isPrimary: z.boolean().optional(),
    comment: ContactCommentField,
  })
  .refine(
    (obj) =>
      obj.name !== undefined ||
      obj.position !== undefined ||
      obj.phone !== undefined ||
      obj.email !== undefined ||
      obj.messenger !== undefined ||
      obj.isPrimary !== undefined ||
      obj.comment !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateSupplierContactDto = z.infer<
  typeof UpdateSupplierContactSchema
>;

// ---------------------------------------------------------------------------
// SupplierCatalogItem — list query / Create / Update
// ---------------------------------------------------------------------------

const CatalogNameRequired = z
  .string()
  .trim()
  .min(1, 'Название позиции обязательно')
  .max(
    SUPPLIER_CATALOG_NAME_MAX_LENGTH,
    `Название не длиннее ${SUPPLIER_CATALOG_NAME_MAX_LENGTH} символов`,
  );
const CatalogNameOptional = z
  .string()
  .trim()
  .min(1, 'Название не может быть пустым')
  .max(
    SUPPLIER_CATALOG_NAME_MAX_LENGTH,
    `Название не длиннее ${SUPPLIER_CATALOG_NAME_MAX_LENGTH} символов`,
  );

const CatalogUnitRequired = z
  .string()
  .trim()
  .min(1, 'Единица измерения обязательна')
  .max(
    SUPPLIER_CATALOG_UNIT_MAX_LENGTH,
    `Единица не длиннее ${SUPPLIER_CATALOG_UNIT_MAX_LENGTH} символов`,
  );
const CatalogUnitOptional = z
  .string()
  .trim()
  .min(1, 'Единица не может быть пустой')
  .max(
    SUPPLIER_CATALOG_UNIT_MAX_LENGTH,
    `Единица не длиннее ${SUPPLIER_CATALOG_UNIT_MAX_LENGTH} символов`,
  );

const CatalogArticleField = optionalNullableText(
  SUPPLIER_CATALOG_ARTICLE_MAX_LENGTH,
  'Артикул',
);
const CatalogCategoryField = optionalNullableText(
  SUPPLIER_CATALOG_CATEGORY_MAX_LENGTH,
  'Категория',
);
const CatalogFabricTypeField = optionalNullableText(
  SUPPLIER_CATALOG_FABRIC_TYPE_MAX_LENGTH,
  'Тип материала',
);
const CatalogColorField = optionalNullableText(
  SUPPLIER_CATALOG_COLOR_MAX_LENGTH,
  'Цвет',
);
const CatalogCurrencyField = optionalNullableText(
  SUPPLIER_CATALOG_CURRENCY_MAX_LENGTH,
  'Валюта',
);
const CatalogCommentField = optionalNullableText(
  SUPPLIER_CATALOG_COMMENT_MAX_LENGTH,
  'Комментарий',
);

export const ListSupplierCatalogQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: SupplierCatalogItemStatusSchema.optional(),
});
export type ListSupplierCatalogQuery = z.infer<
  typeof ListSupplierCatalogQuerySchema
>;

export const CreateSupplierCatalogItemSchema = z.object({
  name: CatalogNameRequired,
  supplierArticle: CatalogArticleField,
  category: CatalogCategoryField,
  fabricType: CatalogFabricTypeField,
  densityGsm: DensityGsmField,
  colorText: CatalogColorField,
  unit: CatalogUnitRequired,
  lastPrice: LastPriceField,
  currency: CatalogCurrencyField,
  minOrderQty: MinOrderQtyField,
  deliveryDays: DeliveryDaysField,
  comment: CatalogCommentField,
  status: SupplierCatalogItemStatusSchema.optional(),
});
export type CreateSupplierCatalogItemDto = z.infer<
  typeof CreateSupplierCatalogItemSchema
>;

export const UpdateSupplierCatalogItemSchema = z
  .object({
    name: CatalogNameOptional.optional(),
    supplierArticle: CatalogArticleField,
    category: CatalogCategoryField,
    fabricType: CatalogFabricTypeField,
    densityGsm: DensityGsmField,
    colorText: CatalogColorField,
    unit: CatalogUnitOptional.optional(),
    lastPrice: LastPriceField,
    currency: CatalogCurrencyField,
    minOrderQty: MinOrderQtyField,
    deliveryDays: DeliveryDaysField,
    comment: CatalogCommentField,
    status: SupplierCatalogItemStatusSchema.optional(),
  })
  .refine(
    (obj) =>
      obj.name !== undefined ||
      obj.supplierArticle !== undefined ||
      obj.category !== undefined ||
      obj.fabricType !== undefined ||
      obj.densityGsm !== undefined ||
      obj.colorText !== undefined ||
      obj.unit !== undefined ||
      obj.lastPrice !== undefined ||
      obj.currency !== undefined ||
      obj.minOrderQty !== undefined ||
      obj.deliveryDays !== undefined ||
      obj.comment !== undefined ||
      obj.status !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdateSupplierCatalogItemDto = z.infer<
  typeof UpdateSupplierCatalogItemSchema
>;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

export interface SupplierContactDto {
  id: string;
  supplierId: string;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  messenger: string | null;
  isPrimary: boolean;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierCatalogItemDto {
  id: string;
  supplierId: string;
  name: string;
  supplierArticle: string | null;
  category: string | null;
  fabricType: string | null;
  densityGsm: number | null;
  colorText: string | null;
  unit: string;
  /** Decimal как строка — формат `Prisma.Decimal.toString()`. */
  lastPrice: string | null;
  currency: string | null;
  minOrderQty: string | null;
  deliveryDays: number | null;
  comment: string | null;
  status: SupplierCatalogItemStatus | string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Тонкий DTO для списка `/admin/suppliers`. Отдаёт счётчики связанных
 * сущностей, чтобы UI мог показать «X контактов / Y позиций» без
 * дополнительных запросов.
 */
export interface SupplierListItemDto {
  id: string;
  name: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  comment: string | null;
  /** Платёжные реквизиты (для заявок на оплату). Все nullable. */
  legalName: string | null;
  inn: string | null;
  kpp: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankBik: string | null;
  bankCorrAccount: string | null;
  status: SupplierStatus | string;
  createdAt: string;
  updatedAt: string;
  contactsCount: number;
  catalogItemsCount: number;
}

/**
 * Подробная карточка поставщика для `/admin/suppliers/[id]` — те же
 * поля + полные списки контактов и каталога.
 */
export interface SupplierDetailDto extends SupplierListItemDto {
  contacts: SupplierContactDto[];
  catalogItems: SupplierCatalogItemDto[];
}
