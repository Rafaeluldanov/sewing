/**
 * Контракты модуля «Заявки на оплату поставщику» (см.
 * `prisma/schema.prisma::SupplierPaymentRequest`,
 * `apps/api/src/modules/supplier-payment-requests/*`).
 *
 * Заявка на оплату — платёжный документ ПОВЕРХ закупочного контура,
 * выписывается внутри карточки `PurchaseOrder`: «оплатить поставщику
 * сумму по реквизитам, разбив на этапы (предоплата 30% / остаток 70%)».
 *
 * Дизайн MVP:
 *   - закупщик НЕ имеет своей роли — используем `ADMIN`/`SHOP_MANAGER`;
 *   - заявка создаётся БЕЗ выбора счёта/статьи ДДС (это решение
 *     казначея на следующем шаге «заявка → казначейство»);
 *   - реквизиты копируются из `Supplier` снимком и редактируются прямо
 *     в заявке;
 *   - процент этапа — первичен, сумма этапа авто-считается на бэкенде
 *     как `round(amount × percent / 100, 2)` (клиентскую сумму не
 *     доверяем);
 *   - «Σ процентов = 100%» — мягкое предупреждение в UI, в схеме НЕ
 *     enforce-им (этапы можно сохранить с любым раскладом);
 *   - `status` — свободная строка, валидация Zod-ом.
 *
 * Контракт типов — источник истины и для backend (ZodValidationPipe),
 * и для frontend (server actions).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл заявки на оплату:
 *   - `DRAFT`     — черновик, можно править;
 *   - `SUBMITTED` — передана в казначейство (на оплату);
 *   - `CANCELLED` — отменена.
 *
 * Расширение списка не требует миграции БД (поле хранится строкой).
 */
export const SUPPLIER_PAYMENT_REQUEST_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'CANCELLED',
] as const;
export type SupplierPaymentRequestStatus =
  (typeof SUPPLIER_PAYMENT_REQUEST_STATUSES)[number];
export const SupplierPaymentRequestStatusSchema = z.enum(
  SUPPLIER_PAYMENT_REQUEST_STATUSES,
);

export const SUPPLIER_PAYMENT_REQUEST_STATUS_LABELS: Record<
  SupplierPaymentRequestStatus,
  string
> = {
  DRAFT: 'Черновик',
  SUBMITTED: 'На оплату',
  CANCELLED: 'Отменена',
};

/**
 * Жизненный цикл этапа оплаты:
 *   - `PENDING`   — ждёт оплаты;
 *   - `PAID`      — оплачен (проставит казначейство при проведении);
 *   - `CANCELLED` — этап отменён.
 */
export const SUPPLIER_PAYMENT_REQUEST_STAGE_STATUSES = [
  'PENDING',
  'PAID',
  'CANCELLED',
] as const;
export type SupplierPaymentRequestStageStatus =
  (typeof SUPPLIER_PAYMENT_REQUEST_STAGE_STATUSES)[number];

export const SUPPLIER_PAYMENT_REQUEST_STAGE_STATUS_LABELS: Record<
  SupplierPaymentRequestStageStatus,
  string
> = {
  PENDING: 'Ожидает оплаты',
  PAID: 'Оплачен',
  CANCELLED: 'Отменён',
};

// ---------------------------------------------------------------------------
// Field constraints
// ---------------------------------------------------------------------------

export const SUPPLIER_PAYMENT_REQUEST_COMMENT_MAX_LENGTH = 2000;
export const SUPPLIER_PAYMENT_REQUEST_STAGE_COMMENT_MAX_LENGTH = 1000;
export const SUPPLIER_PAYMENT_REQUEST_CURRENCY_MAX_LENGTH = 16;

export const SUPPLIER_PAYMENT_REQUEST_LEGAL_NAME_MAX_LENGTH = 300;
export const SUPPLIER_PAYMENT_REQUEST_INN_MAX_LENGTH = 32;
export const SUPPLIER_PAYMENT_REQUEST_KPP_MAX_LENGTH = 32;
export const SUPPLIER_PAYMENT_REQUEST_BANK_NAME_MAX_LENGTH = 300;
export const SUPPLIER_PAYMENT_REQUEST_BANK_ACCOUNT_MAX_LENGTH = 64;
export const SUPPLIER_PAYMENT_REQUEST_BANK_BIK_MAX_LENGTH = 32;
export const SUPPLIER_PAYMENT_REQUEST_BANK_CORR_ACCOUNT_MAX_LENGTH = 64;

/** Sanity-предел суммы — согласован с `PURCHASE_ORDER_PRICE_MAX`. */
export const SUPPLIER_PAYMENT_REQUEST_AMOUNT_MAX = 1_000_000_000;

/** Сколько этапов максимум в одной заявке (UI-репитер). */
export const SUPPLIER_PAYMENT_REQUEST_STAGE_MAX_COUNT = 20;

/** Лимиты вложений (счёт/инвойс + доп. документы). */
export const SUPPLIER_PAYMENT_REQUEST_FILE_MAX_COUNT = 10;
export const SUPPLIER_PAYMENT_REQUEST_FILE_MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 МБ

// ---------------------------------------------------------------------------
// Reusable Zod helpers
// ---------------------------------------------------------------------------

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

const CommentField = optionalNullableText(
  SUPPLIER_PAYMENT_REQUEST_COMMENT_MAX_LENGTH,
  'Комментарий',
);
const StageCommentField = optionalNullableText(
  SUPPLIER_PAYMENT_REQUEST_STAGE_COMMENT_MAX_LENGTH,
  'Комментарий',
);
const CurrencyField = optionalNullableText(
  SUPPLIER_PAYMENT_REQUEST_CURRENCY_MAX_LENGTH,
  'Валюта',
);

const LegalNameField = optionalNullableText(
  SUPPLIER_PAYMENT_REQUEST_LEGAL_NAME_MAX_LENGTH,
  'Юр. название',
);
const InnField = optionalNullableText(
  SUPPLIER_PAYMENT_REQUEST_INN_MAX_LENGTH,
  'ИНН',
);
const KppField = optionalNullableText(
  SUPPLIER_PAYMENT_REQUEST_KPP_MAX_LENGTH,
  'КПП',
);
const BankNameField = optionalNullableText(
  SUPPLIER_PAYMENT_REQUEST_BANK_NAME_MAX_LENGTH,
  'Банк',
);
const BankAccountField = optionalNullableText(
  SUPPLIER_PAYMENT_REQUEST_BANK_ACCOUNT_MAX_LENGTH,
  'Расчётный счёт',
);
const BankBikField = optionalNullableText(
  SUPPLIER_PAYMENT_REQUEST_BANK_BIK_MAX_LENGTH,
  'БИК',
);
const BankCorrAccountField = optionalNullableText(
  SUPPLIER_PAYMENT_REQUEST_BANK_CORR_ACCOUNT_MAX_LENGTH,
  'Корр. счёт',
);

/**
 * Обязательная положительная сумма (Decimal(14,2)). Принимает
 * `string | number`, нормализует запятую в точку, отдаёт строку
 * (`Prisma.Decimal` принимает её как есть).
 */
const AmountRequiredField: z.ZodType<string> = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const raw = typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Сумма обязательна',
      });
      return z.NEVER;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Сумма: число, не более 2 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Сумма должна быть > 0',
      });
      return z.NEVER;
    }
    if (n > SUPPLIER_PAYMENT_REQUEST_AMOUNT_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Сумма: значение выглядит ошибочным',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string>;

/**
 * Процент этапа — `0 < percent <= 100`, до 4 знаков после точки.
 * Отдаётся строкой (для `Prisma.Decimal`).
 */
const PercentRequiredField: z.ZodType<string> = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const raw = typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Процент этапа обязателен',
      });
      return z.NEVER;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Процент: число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Процент должен быть > 0',
      });
      return z.NEVER;
    }
    if (n > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Процент этапа не может превышать 100',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string>;

const DateField: z.ZodType<string | null | undefined> = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const raw = v.trim();
    if (raw === '') return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Дата: некорректный формат',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | null | undefined>;

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Один этап при создании заявки. `percent` первичен, сумма этапа
 * считается на бэкенде. `plannedPayDate` — плановая дата оплаты этапа.
 */
export const CreateSupplierPaymentRequestStageSchema = z.object({
  percent: PercentRequiredField,
  plannedPayDate: DateField,
  comment: StageCommentField,
});
export type CreateSupplierPaymentRequestStageDto = z.infer<
  typeof CreateSupplierPaymentRequestStageSchema
>;

/**
 * Создание заявки на оплату. `purchaseOrderId` берётся из URL
 * (`POST /purchase-orders/:id/payment-requests`), сюда НЕ передаётся.
 * Поставщик и его имя бэкенд берёт из PO; реквизиты приходят из формы
 * (предзаполнены из карточки поставщика, но редактируемы).
 *
 * Этот объект сериализуется в поле `payload` multipart-запроса (файлы
 * идут отдельными полями `files`), см.
 * `SUPPLIER_PAYMENT_REQUEST_FILE_FIELD`.
 */
export const CreateSupplierPaymentRequestSchema = z.object({
  amount: AmountRequiredField,
  currency: CurrencyField,
  comment: CommentField,

  legalName: LegalNameField,
  inn: InnField,
  kpp: KppField,
  bankName: BankNameField,
  bankAccount: BankAccountField,
  bankBik: BankBikField,
  bankCorrAccount: BankCorrAccountField,

  stages: z
    .array(CreateSupplierPaymentRequestStageSchema)
    .min(1, 'Нужен хотя бы один этап оплаты')
    .max(
      SUPPLIER_PAYMENT_REQUEST_STAGE_MAX_COUNT,
      `Не более ${SUPPLIER_PAYMENT_REQUEST_STAGE_MAX_COUNT} этапов`,
    ),
});
export type CreateSupplierPaymentRequestDto = z.infer<
  typeof CreateSupplierPaymentRequestSchema
>;

/** Имя файлового поля в multipart-запросе создания заявки. */
export const SUPPLIER_PAYMENT_REQUEST_FILE_FIELD = 'files';

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

export interface SupplierPaymentRequestStageDto {
  id: string;
  sortOrder: number;
  /** Decimal как строка (`Prisma.Decimal.toString()`). */
  percent: string;
  amount: string;
  plannedPayDate: string | null;
  status: SupplierPaymentRequestStageStatus | string;
  supplierPaymentId: string | null;
  comment: string | null;
}

export interface SupplierPaymentRequestFileDto {
  id: string;
  fileUrl: string;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface SupplierPaymentRequestListItemDto {
  id: string;
  number: string;
  purchaseOrderId: string;
  supplierId: string;
  supplierNameSnapshot: string;
  amount: string;
  currency: string | null;
  status: SupplierPaymentRequestStatus | string;
  stagesCount: number;
  filesCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierPaymentRequestDetailDto
  extends SupplierPaymentRequestListItemDto {
  legalNameSnapshot: string | null;
  innSnapshot: string | null;
  kppSnapshot: string | null;
  bankNameSnapshot: string | null;
  bankAccountSnapshot: string | null;
  bankBikSnapshot: string | null;
  bankCorrAccountSnapshot: string | null;
  comment: string | null;
  createdById: string | null;
  stages: SupplierPaymentRequestStageDto[];
  files: SupplierPaymentRequestFileDto[];
}
