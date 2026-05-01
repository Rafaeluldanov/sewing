/**
 * Контракты модуля «Заказы поставщикам» (Этап 6А, см.
 * `docs/recon-soft-integration.md §«Этап 6А»`,
 * `prisma/schema.prisma::PurchaseOrder`,
 * `apps/api/src/modules/purchase-orders/*`).
 *
 * Дизайн MVP:
 *   - закупщик НЕ имеет своей роли — используем `ADMIN`/`SHOP_MANAGER`;
 *   - НЕТ приёмки, НЕТ MaterialReceipt / FabricRoll, НЕТ ячеек;
 *   - НЕТ оплаты поставщику / платёжных документов;
 *   - PO создаётся ТОЛЬКО из `WorkshopNeed` с
 *     `selectedSupplierId` (см. `CreatePurchaseOrderFromNeedsSchema`);
 *   - все потребности должны иметь одного поставщика и (на MVP)
 *     одного заказа покупателя — иначе backend отдаёт
 *     `PURCHASE_ORDER_NEEDS_DIFFERENT_*` ошибки;
 *   - `status` хранится как свободная строка в БД, валидация
 *     Zod-ом по `PURCHASE_ORDER_STATUSES`.
 *
 * Контракт типов — источник истины для:
 *   - backend (Nest controllers/services) валидирует через
 *     ZodValidationPipe;
 *   - frontend (RSC + server actions) использует те же схемы
 *     при отправке форм.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл закупочного документа:
 *
 * - `DRAFT`     — только что создан, можно править строки и
 *   шапку;
 * - `SENT`      — отправлен поставщику; зафиксирован `sentAt`,
 *   все активные строки переведены в `SENT`;
 * - `CONFIRMED` — поставщик подтвердил; зафиксирован
 *   `confirmedAt` и опционально подтверждённые количества/цены/
 *   даты по строкам;
 * - `CANCELLED` — заказ отменён; строки переведены в `CANCELLED`,
 *   связанные `WorkshopNeed` возвращаются в `PURCHASE_PLANNED`,
 *   если по ним больше нет активных строк.
 *
 * Расширение списка (например, `PARTIALLY_CONFIRMED`) сводится к
 * добавлению значения сюда + лейбла в `PURCHASE_ORDER_STATUS_LABELS`,
 * без миграции БД.
 */
export const PURCHASE_ORDER_STATUSES = [
  'DRAFT',
  'SENT',
  'CONFIRMED',
  /**
   * Этап 7А «Приёмка поставок»: по PO зарегистрирована минимум одна
   * `PurchaseReceiptLine` (`status = POSTED`), но суммарное
   * `Σ receivedQty` пока не покрыло целевой `confirmedQty ?? qty` по
   * всем активным строкам PO.
   */
  'PARTIALLY_RECEIVED',
  /**
   * Этап 7А: все активные строки PO имеют `status = RECEIVED`
   * (суммарное `Σ receivedQty ≥ confirmedQty ?? qty`).
   */
  'RECEIVED',
  'CANCELLED',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];
export const PurchaseOrderStatusSchema = z.enum(PURCHASE_ORDER_STATUSES);

export const PURCHASE_ORDER_STATUS_LABELS: Record<
  PurchaseOrderStatus,
  string
> = {
  DRAFT: 'Черновик',
  SENT: 'Отправлен поставщику',
  CONFIRMED: 'Подтверждён поставщиком',
  PARTIALLY_RECEIVED: 'Частично получено',
  RECEIVED: 'Получено',
  CANCELLED: 'Отменён',
};

/**
 * Активные статусы PO — те, при которых строки PO считаются
 * «реально занимающими» соответствующую `WorkshopNeed`.
 * Используется и в backend (`PurchaseOrdersService.cancel`,
 * `createFromNeeds`), и в frontend (UI).
 *
 * `PARTIALLY_RECEIVED`/`RECEIVED` — тоже активные: пока PO не
 * `CANCELLED`, по нему «занята» соответствующая потребность.
 */
export const PURCHASE_ORDER_ACTIVE_STATUSES: ReadonlyArray<PurchaseOrderStatus> = [
  'DRAFT',
  'SENT',
  'CONFIRMED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
];

/**
 * Этап 7А: статусы PO, по которым разрешена приёмка. `DRAFT` нельзя
 * принимать (документ ещё не отправлен поставщику), `CANCELLED` —
 * тоже нельзя.
 */
export const PURCHASE_ORDER_RECEIVABLE_STATUSES: ReadonlyArray<PurchaseOrderStatus> =
  ['SENT', 'CONFIRMED', 'PARTIALLY_RECEIVED'];

/**
 * Жизненный цикл строки закупочного документа. На MVP полностью
 * совпадает с `PURCHASE_ORDER_STATUSES`. Держим отдельный массив,
 * чтобы потом независимо расширить (например, `PARTIALLY_RECEIVED`,
 * когда появится приёмка — но это уже за пределами этапа 6А).
 */
export const PURCHASE_ORDER_LINE_STATUSES = [
  'DRAFT',
  'SENT',
  'CONFIRMED',
  /** Этап 7А: см. описание у `PURCHASE_ORDER_STATUSES`. */
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED',
] as const;
export type PurchaseOrderLineStatus =
  (typeof PURCHASE_ORDER_LINE_STATUSES)[number];
export const PurchaseOrderLineStatusSchema = z.enum(
  PURCHASE_ORDER_LINE_STATUSES,
);

export const PURCHASE_ORDER_LINE_STATUS_LABELS: Record<
  PurchaseOrderLineStatus,
  string
> = {
  DRAFT: 'Черновик',
  SENT: 'Отправлено',
  CONFIRMED: 'Подтверждено',
  PARTIALLY_RECEIVED: 'Частично получено',
  RECEIVED: 'Получено',
  CANCELLED: 'Отменено',
};

export const PURCHASE_ORDER_LINE_ACTIVE_STATUSES: ReadonlyArray<PurchaseOrderLineStatus> =
  ['DRAFT', 'SENT', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED'];

// ---------------------------------------------------------------------------
// Field constraints
// ---------------------------------------------------------------------------

export const PURCHASE_ORDER_COMMENT_MAX_LENGTH = 2000;
export const PURCHASE_ORDER_LINE_COMMENT_MAX_LENGTH = 1000;
export const PURCHASE_ORDER_CURRENCY_MAX_LENGTH = 16;
/**
 * Sanity-предел для денежных полей. Совпадает с
 * `WORKSHOP_NEED_PRICE_MAX` / `SUPPLIER_PRICE_MAX`, чтобы UI был
 * согласован.
 */
export const PURCHASE_ORDER_PRICE_MAX = 1_000_000_000;
export const PURCHASE_ORDER_QTY_MAX = 1_000_000_000;

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
  PURCHASE_ORDER_COMMENT_MAX_LENGTH,
  'Комментарий',
);
const LineCommentField = optionalNullableText(
  PURCHASE_ORDER_LINE_COMMENT_MAX_LENGTH,
  'Комментарий',
);
const CurrencyField = optionalNullableText(
  PURCHASE_ORDER_CURRENCY_MAX_LENGTH,
  'Валюта',
);

const QtyField: z.ZodType<string | null | undefined> = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const raw =
      typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') return null;
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Количество: положительное число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Количество должно быть > 0',
      });
      return z.NEVER;
    }
    if (n > PURCHASE_ORDER_QTY_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Количество: значение выглядит ошибочным',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | null | undefined>;

const PriceField: z.ZodType<string | null | undefined> = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const raw =
      typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Цена: число, не более 2 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Цена должна быть >= 0',
      });
      return z.NEVER;
    }
    if (n > PURCHASE_ORDER_PRICE_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Цена: значение выглядит ошибочным',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | null | undefined>;

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
// List query
// ---------------------------------------------------------------------------

export const ListPurchaseOrdersQuerySchema = z.object({
  /**
   * Поиск по `number` / `supplierNameSnapshot` / `comment` (case-
   * insensitive `contains`).
   */
  search: z.string().trim().max(120).optional(),
  status: PurchaseOrderStatusSchema.optional(),
  supplierId: z.string().min(1).optional(),
  /** Фильтр по заказу покупателя. */
  customerOrderId: z.string().min(1).optional(),
});
export type ListPurchaseOrdersQuery = z.infer<
  typeof ListPurchaseOrdersQuerySchema
>;

// ---------------------------------------------------------------------------
// Create from needs
// ---------------------------------------------------------------------------

/**
 * Создание PO из набора `WorkshopNeed`. См.
 * `PurchaseOrdersService.createFromNeeds`. Все потребности должны:
 *   - существовать;
 *   - иметь одного `selectedSupplierId` (поставщик ACTIVE);
 *   - иметь `purchaseQty > 0`;
 *   - не быть `CANCELLED`;
 *   - НЕ иметь активной `PurchaseOrderLine` (DRAFT/SENT/CONFIRMED);
 *   - на MVP — относиться к одному `customerOrderId`.
 */
export const CreatePurchaseOrderFromNeedsSchema = z.object({
  workshopNeedIds: z
    .array(z.string().min(1))
    .min(1, 'Нужна хотя бы одна потребность'),
  comment: CommentField,
  expectedDeliveryDate: DateField,
});
export type CreatePurchaseOrderFromNeedsDto = z.infer<
  typeof CreatePurchaseOrderFromNeedsSchema
>;

// ---------------------------------------------------------------------------
// Update PO header
// ---------------------------------------------------------------------------

export const UpdatePurchaseOrderSchema = z
  .object({
    comment: CommentField,
    expectedDeliveryDate: DateField,
    /**
     * Прямое управление статусом через PATCH разрешено, но backend
     * проверяет валидность перехода (см.
     * `PurchaseOrderInvalidStatusTransitionException`). UI
     * рекомендуется использовать дедикейтед-actions
     * (`/send`, `/confirm`, `/cancel`), которые ставят правильные
     * timestamps и каскадят строки.
     */
    status: PurchaseOrderStatusSchema.optional(),
  })
  .refine(
    (obj) =>
      obj.comment !== undefined ||
      obj.expectedDeliveryDate !== undefined ||
      obj.status !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdatePurchaseOrderDto = z.infer<typeof UpdatePurchaseOrderSchema>;

// ---------------------------------------------------------------------------
// Update PO line
// ---------------------------------------------------------------------------

export const UpdatePurchaseOrderLineSchema = z
  .object({
    qty: QtyField,
    price: PriceField,
    currency: CurrencyField,
    expectedDeliveryDate: DateField,
    confirmedQty: QtyField,
    confirmedPrice: PriceField,
    confirmedDeliveryDate: DateField,
    comment: LineCommentField,
    status: PurchaseOrderLineStatusSchema.optional(),
  })
  .refine(
    (obj) =>
      obj.qty !== undefined ||
      obj.price !== undefined ||
      obj.currency !== undefined ||
      obj.expectedDeliveryDate !== undefined ||
      obj.confirmedQty !== undefined ||
      obj.confirmedPrice !== undefined ||
      obj.confirmedDeliveryDate !== undefined ||
      obj.comment !== undefined ||
      obj.status !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdatePurchaseOrderLineDto = z.infer<
  typeof UpdatePurchaseOrderLineSchema
>;

// ---------------------------------------------------------------------------
// Confirm PO (с опциональными подтверждениями по строкам)
// ---------------------------------------------------------------------------

export const ConfirmPurchaseOrderLineSchema = z.object({
  lineId: z.string().min(1),
  confirmedQty: QtyField,
  confirmedPrice: PriceField,
  confirmedDeliveryDate: DateField,
  comment: LineCommentField,
});
export type ConfirmPurchaseOrderLineDto = z.infer<
  typeof ConfirmPurchaseOrderLineSchema
>;

export const ConfirmPurchaseOrderSchema = z.object({
  /**
   * Время подтверждения. Если не задано — backend использует `now`.
   * Поле оставлено в DTO ради будущего «менеджер вводит дату вручную».
   */
  confirmedAt: DateField,
  /**
   * Опциональные подтверждения по строкам. Если строки не переданы,
   * backend просто помечает все активные строки как `CONFIRMED` без
   * перезаписи `confirmedQty`/`confirmedPrice`/`confirmedDeliveryDate`.
   */
  lines: z.array(ConfirmPurchaseOrderLineSchema).optional(),
});
export type ConfirmPurchaseOrderDto = z.infer<
  typeof ConfirmPurchaseOrderSchema
>;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

export interface PurchaseOrderLineDto {
  id: string;
  workshopNeedId: string | null;
  supplierCatalogItemId: string | null;
  itemNameSnapshot: string;
  supplierArticleSnapshot: string | null;
  unitSnapshot: string;
  /** Decimal как строка (формат `Prisma.Decimal.toString()`). */
  catalogLastPriceSnapshot: string | null;
  qty: string;
  price: string | null;
  currency: string | null;
  expectedDeliveryDate: string | null;
  confirmedQty: string | null;
  confirmedPrice: string | null;
  confirmedDeliveryDate: string | null;
  status: PurchaseOrderLineStatus | string;
  comment: string | null;
  createdAt: string;
  updatedAt: string;

  /** Описание исходной потребности — для UI-таблицы PO. */
  workshopNeedDescription: string | null;
  /** Номер заказа покупателя, к которому относится потребность. */
  customerOrderNumber: string | null;
}

export interface PurchaseOrderListItemDto {
  id: string;
  number: string;
  supplierId: string;
  supplierNameSnapshot: string;
  customerOrderId: string | null;
  customerOrderNumber: string | null;
  status: PurchaseOrderStatus | string;
  expectedDeliveryDate: string | null;
  sentAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  linesCount: number;
  /**
   * Сумма `Σ(qty × price)` по активным строкам (не CANCELLED). `null`,
   * если ни в одной строке не задана `price` — нет смысла показывать
   * 0₽, это путает менеджера.
   */
  totalAmount: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrderDetailDto extends PurchaseOrderListItemDto {
  supplierPhoneSnapshot: string | null;
  supplierWebsiteSnapshot: string | null;
  supplierAddressSnapshot: string | null;
  comment: string | null;
  lines: PurchaseOrderLineDto[];
}
