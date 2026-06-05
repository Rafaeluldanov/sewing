/**
 * Контракты модуля «Приёмка поставок» (Этап 7А, см.
 * `docs/recon-soft-integration.md §«Этап 7А»`,
 * `prisma/schema.prisma::PurchaseReceipt` / `PurchaseReceiptLine`,
 * `apps/api/src/modules/purchase-receipts/*`).
 *
 * Дизайн MVP:
 *   - закупщик/кладовщик НЕ имеют своей роли — используем
 *     `ADMIN`/`SHOP_MANAGER`;
 *   - НЕТ полноценного складского остатка: размещение хранится
 *     прямо в `PurchaseReceiptLine.cellId`, без записей
 *     `CellContent` / `MaterialStock` / `FabricRoll`;
 *   - НЕТ перемещений между ячейками, НЕТ списания в крой;
 *   - НЕТ оплаты поставщику;
 *   - PR создаётся ТОЛЬКО из `PurchaseOrder` через
 *     `createFromPurchaseOrder` (см. сервис);
 *   - `status` хранится как свободная строка в БД, валидация
 *     Zod-ом по `PURCHASE_RECEIPT_STATUSES`.
 *
 * Контракт типов — источник истины для backend (Nest controllers/
 * services валидируют ZodValidationPipe-ом) и frontend (RSC + server
 * actions используют те же схемы при отправке форм).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл документа приёмки:
 *
 * - `DRAFT`     — черновик: документ собран, но ещё не проведён.
 *   Строки тоже `DRAFT`, статусы PO/PO-line/WorkshopNeed НЕ
 *   пересчитываются, складские движения НЕ пишутся. Черновик
 *   можно свободно редактировать (`PATCH .../lines/:lineId`) и
 *   провести (`POST .../post`) или удалить отменой.
 * - `POSTED`    — проведённый документ; строки тоже `POSTED`,
 *   статусы PO/PO-line/WorkshopNeed пересчитываются вверх
 *   (`PARTIALLY_RECEIVED`/`RECEIVED`), пишутся `StockMovement` (IN);
 * - `CANCELLED` — отменён; строки тоже `CANCELLED`, статусы
 *   PO/PO-line/WorkshopNeed пересчитываются вниз с учётом
 *   оставшихся `POSTED`-строк по другим документам.
 *
 * Расширение списка сводится к добавлению значения сюда + лейбла
 * в `PURCHASE_RECEIPT_STATUS_LABELS`, без миграции БД.
 */
export const PURCHASE_RECEIPT_STATUSES = [
  'DRAFT',
  'POSTED',
  'CANCELLED',
] as const;
export type PurchaseReceiptStatus = (typeof PURCHASE_RECEIPT_STATUSES)[number];
export const PurchaseReceiptStatusSchema = z.enum(PURCHASE_RECEIPT_STATUSES);

export const PURCHASE_RECEIPT_STATUS_LABELS: Record<
  PurchaseReceiptStatus,
  string
> = {
  DRAFT: 'Черновик',
  POSTED: 'Принято',
  CANCELLED: 'Отменено',
};

/**
 * Активные статусы документа приёмки — те, при которых строки
 * считаются «реально полученными» (учитываются в пересчёте
 * статусов PO/PO-line/WorkshopNeed). На MVP это только `POSTED`.
 */
export const PURCHASE_RECEIPT_ACTIVE_STATUSES: ReadonlyArray<PurchaseReceiptStatus> =
  ['POSTED'];

/**
 * Жизненный цикл строки приёмки. На MVP полностью совпадает со
 * статусом заголовка. Держим отдельный массив на случай, если в
 * будущем строки начнут меняться независимо (например,
 * частичная отмена позиций без отмены документа).
 */
export const PURCHASE_RECEIPT_LINE_STATUSES = [
  'DRAFT',
  'POSTED',
  'CANCELLED',
] as const;
export type PurchaseReceiptLineStatus =
  (typeof PURCHASE_RECEIPT_LINE_STATUSES)[number];
export const PurchaseReceiptLineStatusSchema = z.enum(
  PURCHASE_RECEIPT_LINE_STATUSES,
);

export const PURCHASE_RECEIPT_LINE_STATUS_LABELS: Record<
  PurchaseReceiptLineStatus,
  string
> = {
  DRAFT: 'Черновик',
  POSTED: 'Принято',
  CANCELLED: 'Отменено',
};

export const PURCHASE_RECEIPT_LINE_ACTIVE_STATUSES: ReadonlyArray<PurchaseReceiptLineStatus> =
  ['POSTED'];

// ---------------------------------------------------------------------------
// Field constraints
// ---------------------------------------------------------------------------

export const PURCHASE_RECEIPT_COMMENT_MAX_LENGTH = 2000;
export const PURCHASE_RECEIPT_LINE_COMMENT_MAX_LENGTH = 1000;
export const PURCHASE_RECEIPT_TEXT_FIELD_MAX_LENGTH = 200;

/**
 * Sanity-предел для `receivedQty`. Совпадает с
 * `PURCHASE_ORDER_QTY_MAX` / `WORKSHOP_NEED_QTY_MAX` для UI-консистентности.
 */
export const PURCHASE_RECEIPT_QTY_MAX = 1_000_000_000;

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
  PURCHASE_RECEIPT_COMMENT_MAX_LENGTH,
  'Комментарий',
);
const LineCommentField = optionalNullableText(
  PURCHASE_RECEIPT_LINE_COMMENT_MAX_LENGTH,
  'Комментарий',
);
const ShortText = (label: string) =>
  optionalNullableText(PURCHASE_RECEIPT_TEXT_FIELD_MAX_LENGTH, label);

const BatchNumberField = ShortText('Номер партии');
const RollNumberField = ShortText('Номер рулона');
const ShadeField = ShortText('Оттенок');
const LocationNoteField = ShortText('Место хранения');

/**
 * Опциональная ссылка на ячейку: строка-id, `null` (явно очистить)
 * или `undefined` (поле не передано).
 */
const CellIdField = z.preprocess(
  (v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  },
  z.string().min(1).nullable().optional(),
) as unknown as z.ZodType<string | null | undefined>;

/**
 * Целое неотрицательное число (для `actualWidthCm` / `actualDensityGsm`).
 * Принимает `string | number | null | undefined`.
 */
function nonNegativeIntField(
  label: string,
  max: number,
): z.ZodType<number | null | undefined> {
  return z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const raw = typeof v === 'number' ? String(v) : v.trim();
      if (raw === '') return null;
      if (!/^\d+$/.test(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: целое число ≥ 0`,
        });
        return z.NEVER;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: целое число ≥ 0`,
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

const ActualWidthField = nonNegativeIntField('Ширина (см)', 100_000);
const ActualDensityField = nonNegativeIntField('Плотность (г/м²)', 100_000);

/**
 * `receivedQty` — обязательное положительное число с не более чем
 * 4 знаками после точки (Decimal(14,4) совпадает с
 * `PurchaseOrderLine.qty`).
 */
const ReceivedQtyField: z.ZodType<string> = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const raw =
      typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Принятое количество обязательно',
      });
      return z.NEVER;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Принятое количество: положительное число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Принятое количество должно быть > 0',
      });
      return z.NEVER;
    }
    if (n > PURCHASE_RECEIPT_QTY_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Принятое количество: значение выглядит ошибочным',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string>;

/**
 * Дата приёмки (опционально). Принимаем ISO-строку или пустую
 * строку (нормализуется в `null`). Backend сам преобразует в `Date`.
 */
const ReceivedAtField: z.ZodType<string | null | undefined> = z
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
        message: 'Дата приёмки: некорректный формат',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | null | undefined>;

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export const ListPurchaseReceiptsQuerySchema = z.object({
  /**
   * Поиск по `number` / `supplierNameSnapshot` / `comment` /
   * номеру PO / номеру заказа покупателя (case-insensitive
   * `contains`).
   */
  search: z.string().trim().max(120).optional(),
  status: PurchaseReceiptStatusSchema.optional(),
  purchaseOrderId: z.string().min(1).optional(),
  customerOrderId: z.string().min(1).optional(),
  supplierId: z.string().min(1).optional(),
  cellId: z.string().min(1).optional(),
});
export type ListPurchaseReceiptsQuery = z.infer<
  typeof ListPurchaseReceiptsQuerySchema
>;

// ---------------------------------------------------------------------------
// Create from PurchaseOrder
// ---------------------------------------------------------------------------

/**
 * Одна строка фактической приёмки, передаваемая в
 * `POST /api/purchase-receipts/from-purchase-order`.
 *
 * `purchaseOrderLineId` обязателен на MVP — приёмку без привязки
 * к строке PO мы не оформляем (нечем восстанавливать item-snapshot).
 */
export const CreatePurchaseReceiptLineFromPurchaseOrderSchema = z.object({
  purchaseOrderLineId: z.string().min(1, 'Не указана строка заказа поставщику'),
  receivedQty: ReceivedQtyField,
  cellId: CellIdField,
  batchNumber: BatchNumberField,
  rollNumber: RollNumberField,
  shade: ShadeField,
  actualWidthCm: ActualWidthField,
  actualDensityGsm: ActualDensityField,
  locationNote: LocationNoteField,
  comment: LineCommentField,
});
export type CreatePurchaseReceiptLineFromPurchaseOrderDto = z.infer<
  typeof CreatePurchaseReceiptLineFromPurchaseOrderSchema
>;

export const CreatePurchaseReceiptFromPurchaseOrderSchema = z.object({
  purchaseOrderId: z.string().min(1, 'Не указан заказ поставщику'),
  receivedAt: ReceivedAtField,
  comment: CommentField,
  /**
   * Если `true` — документ создаётся в статусе `DRAFT`: строки не
   * проводятся, статусы PO/потребности не пересчитываются, склад не
   * двигается. Черновик можно отредактировать и провести позже
   * (`POST /api/purchase-receipts/:id/post`). По умолчанию (`false`/
   * `undefined`) — сразу `POSTED`.
   */
  draft: z.boolean().optional(),
  lines: z
    .array(CreatePurchaseReceiptLineFromPurchaseOrderSchema)
    .min(1, 'Нужна хотя бы одна строка приёмки'),
});
export type CreatePurchaseReceiptFromPurchaseOrderDto = z.infer<
  typeof CreatePurchaseReceiptFromPurchaseOrderSchema
>;

// ---------------------------------------------------------------------------
// Update receipt line (правка строки после создания)
// ---------------------------------------------------------------------------

/**
 * `receivedQty` для PATCH строки — опциональный (правится только у
 * `DRAFT`-приёмки, backend это проверяет). Та же валидация, что и у
 * `ReceivedQtyField`, но поле можно не передавать.
 */
const OptionalReceivedQtyField: z.ZodType<string | undefined> = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const raw =
      typeof v === 'number' ? String(v) : v.trim().replace(',', '.');
    if (raw === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Принятое количество не может быть пустым',
      });
      return z.NEVER;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Принятое количество: положительное число, не более 4 знаков после точки',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Принятое количество должно быть > 0',
      });
      return z.NEVER;
    }
    if (n > PURCHASE_RECEIPT_QTY_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Принятое количество: значение выглядит ошибочным',
      });
      return z.NEVER;
    }
    return raw;
  }) as unknown as z.ZodType<string | undefined>;

/**
 * Правка строки приёмки (`PATCH /api/purchase-receipts/:id/lines/:lineId`).
 *
 * Какие поля реально применятся — зависит от статуса документа
 * (backend, `PurchaseReceiptsService.updateLine`):
 *   - `DRAFT`  — можно править всё, включая `receivedQty` и `cellId`;
 *   - `POSTED` — только нескладские метаданные (`batchNumber`,
 *     `rollNumber`, `shade`, `actualWidthCm`, `actualDensityGsm`,
 *     `locationNote`, `comment`). Правка `receivedQty`/`cellId` у
 *     проведённого документа запрещена (рассинхронит склад) — для
 *     этого приёмку отменяют и оформляют заново.
 */
export const UpdatePurchaseReceiptLineSchema = z
  .object({
    receivedQty: OptionalReceivedQtyField,
    cellId: CellIdField,
    batchNumber: BatchNumberField,
    rollNumber: RollNumberField,
    shade: ShadeField,
    actualWidthCm: ActualWidthField,
    actualDensityGsm: ActualDensityField,
    locationNote: LocationNoteField,
    comment: LineCommentField,
  })
  .refine(
    (obj) =>
      obj.receivedQty !== undefined ||
      obj.cellId !== undefined ||
      obj.batchNumber !== undefined ||
      obj.rollNumber !== undefined ||
      obj.shade !== undefined ||
      obj.actualWidthCm !== undefined ||
      obj.actualDensityGsm !== undefined ||
      obj.locationNote !== undefined ||
      obj.comment !== undefined,
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdatePurchaseReceiptLineDto = z.infer<
  typeof UpdatePurchaseReceiptLineSchema
>;

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export const CancelPurchaseReceiptSchema = z.object({
  /**
   * Причина отмены. На MVP свободный текст, фиксируется в
   * `PurchaseReceipt.comment` (если уже не задан) и в audit-payload.
   */
  reason: optionalNullableText(
    PURCHASE_RECEIPT_COMMENT_MAX_LENGTH,
    'Причина',
  ),
});
export type CancelPurchaseReceiptDto = z.infer<
  typeof CancelPurchaseReceiptSchema
>;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

export interface PurchaseReceiptLineDto {
  id: string;
  purchaseOrderLineId: string | null;
  workshopNeedId: string | null;
  supplierCatalogItemId: string | null;
  itemNameSnapshot: string;
  supplierArticleSnapshot: string | null;
  unitSnapshot: string;
  /** Decimal как строка (формат `Prisma.Decimal.toString()`). */
  orderedQtySnapshot: string | null;
  confirmedQtySnapshot: string | null;
  priceSnapshot: string | null;
  currencySnapshot: string | null;
  receivedQty: string;
  unit: string;
  batchNumber: string | null;
  rollNumber: string | null;
  shade: string | null;
  actualWidthCm: number | null;
  actualDensityGsm: number | null;
  /** Размещение. */
  cellId: string | null;
  cellCode: string | null;
  warehouseName: string | null;
  lineName: string | null;
  locationNote: string | null;
  status: PurchaseReceiptLineStatus | string;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseReceiptListItemDto {
  id: string;
  number: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  supplierId: string | null;
  supplierNameSnapshot: string | null;
  customerOrderId: string | null;
  customerOrderNumber: string | null;
  status: PurchaseReceiptStatus | string;
  receivedAt: string;
  cancelledAt: string | null;
  /** Кто принял — для колонки в списке. `null`, если автор неизвестен. */
  receivedById: string | null;
  receivedByName: string | null;
  linesCount: number;
  /**
   * Суммарное `Σ receivedQty` по активным (не CANCELLED) строкам
   * приёмки. На MVP отдаём строкой (decimal-as-string) — UI
   * показывает её только справочно, без бизнес-инвариантов.
   */
  totalReceivedQty: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseReceiptDetailDto extends PurchaseReceiptListItemDto {
  supplierPhoneSnapshot: string | null;
  supplierWebsiteSnapshot: string | null;
  supplierAddressSnapshot: string | null;
  comment: string | null;
  receivedById: string | null;
  receivedByName: string | null;
  lines: PurchaseReceiptLineDto[];
}
