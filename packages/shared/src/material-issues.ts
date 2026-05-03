/**
 * Контракты модуля «Фактический расход материалов по заказу»
 * (см. `apps/api/src/modules/material-issues/*`,
 * `prisma/schema.prisma::MaterialIssue` / `MaterialIssueLine`,
 * `docs/api.md §«Material issues»`).
 *
 * Дизайн MVP (см. ТЗ):
 *   - документ `MaterialIssue` + строки `MaterialIssueLine` фиксируются
 *     менеджером вручную (ADMIN / SHOP_MANAGER);
 *   - НЕТ `StockBalance` / `MaterialStockLot` / `StockMovement`;
 *   - НЕТ FIFO/LIFO;
 *   - НЕТ автосписания при выдаче кроя;
 *   - POSTED-документ отменить нельзя;
 *   - `status` хранится в БД как строка, валидируется Zod-ом по
 *     `MATERIAL_ISSUE_STATUSES` — расширение списка не требует
 *     миграции.
 *
 * Контракт Zod-схем здесь зеркалирует backend DTO
 * (`apps/api/src/modules/material-issues/dto/*.ts`). Фронт использует
 * `Create…Schema` / `Cancel…Schema` для валидации `<form>`-сабмита
 * server actions — ровно так же, как другие модули (см.
 * `packages/shared/src/purchase-receipts.ts`,
 * `packages/shared/src/order-material-arrivals.ts`).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл документа `MaterialIssue`:
 *
 * - `DRAFT`     — черновик. Можно провести (`POST /:id/post`) или
 *                 отменить (`POST /:id/cancel`).
 * - `POSTED`    — проведён. Менять/отменить нельзя в MVP.
 * - `CANCELLED` — отменён в DRAFT.
 */
export const MATERIAL_ISSUE_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED'] as const;
export type MaterialIssueStatus = (typeof MATERIAL_ISSUE_STATUSES)[number];
export const MaterialIssueStatusSchema = z.enum(MATERIAL_ISSUE_STATUSES);

export const MATERIAL_ISSUE_STATUS_LABELS: Record<MaterialIssueStatus, string> = {
  DRAFT: 'Черновик',
  POSTED: 'Проведён',
  CANCELLED: 'Отменён',
};

// ---------------------------------------------------------------------------
// Sources (источник возникновения документа)
// ---------------------------------------------------------------------------

/**
 * Источник возникновения документа `MaterialIssue`:
 *
 * - `MANUAL`         — менеджер создал документ вручную через
 *                      `POST /api/material-issues`. Значение по
 *                      умолчанию для всех пользовательских документов.
 * - `AUTO_CUT_ISSUE` — документ создан автоматически в той же
 *                      транзакции, что и `PassportsService.issueToEmployee`
 *                      (автосписание материалов при выдаче кроя
 *                      сотруднику). `sourceKey` обеспечивает
 *                      идемпотентность при retry. См.
 *                      `apps/api/src/modules/material-issues/material-issues.service.ts::createAutoCutIssueForPassport`,
 *                      `docs/current-state.md §«Auto cut issue»`.
 *
 * Поле хранится в БД как `String`, чтобы расширять список источников
 * (будущие сторнирующие/корректировочные автодокументы) без
 * миграции. Frontend DTO `source`/`sourceKey` не принимает —
 * источник решает сервис.
 */
export const MATERIAL_ISSUE_SOURCES = ['MANUAL', 'AUTO_CUT_ISSUE'] as const;
export type MaterialIssueSource = (typeof MATERIAL_ISSUE_SOURCES)[number];

// ---------------------------------------------------------------------------
// Field constraints
// ---------------------------------------------------------------------------

export const MATERIAL_ISSUE_LINE_DESCRIPTION_MAX_LENGTH = 500;
export const MATERIAL_ISSUE_LINE_UNIT_MAX_LENGTH = 32;
export const MATERIAL_ISSUE_LINE_COMMENT_MAX_LENGTH = 2000;
export const MATERIAL_ISSUE_CANCEL_REASON_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Reusable Zod helpers
// ---------------------------------------------------------------------------

/**
 * Decimal-as-string. Принимаем `string | number`, нормализуем к
 * строке (локали `,` → `.`), валидируем формат
 * (опциональный знак минуса + цифры + опциональная дробная часть
 * до 4 знаков). Граничные проверки `> 0` / `>= 0` — отдельные
 * refinement'ы ниже. Зеркалит backend
 * (`create-material-issue.dto.ts::decimalStringLike`).
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

const nonNegativeDecimal = decimalStringLike.refine(
  (value) => Number(value) >= 0,
  { message: 'Цена не может быть отрицательной' },
);

const trimmedString = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------
// Create DTO
// ---------------------------------------------------------------------------

export const CreateMaterialIssueLineSchema = z
  .object({
    workshopNeedId: trimmedString(64).optional(),
    description: z
      .string()
      .trim()
      .min(1)
      .max(MATERIAL_ISSUE_LINE_DESCRIPTION_MAX_LENGTH)
      .optional(),
    unit: z
      .string()
      .trim()
      .min(1)
      .max(MATERIAL_ISSUE_LINE_UNIT_MAX_LENGTH)
      .optional(),
    issuedQty: positiveDecimal,
    unitCost: nonNegativeDecimal,
    cellId: trimmedString(64).optional(),
    comment: z
      .string()
      .trim()
      .max(MATERIAL_ISSUE_LINE_COMMENT_MAX_LENGTH)
      .optional(),
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

// ---------------------------------------------------------------------------
// Cancel DTO
// ---------------------------------------------------------------------------

export const CancelMaterialIssueSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .max(MATERIAL_ISSUE_CANCEL_REASON_MAX_LENGTH)
      .optional(),
  })
  .strict();
export type CancelMaterialIssueDto = z.infer<typeof CancelMaterialIssueSchema>;

// ---------------------------------------------------------------------------
// List query DTO
// ---------------------------------------------------------------------------

export const ListMaterialIssuesQuerySchema = z
  .object({
    orderId: z.string().trim().min(1).max(64).optional(),
    passportId: z.string().trim().min(1).max(64).optional(),
    status: MaterialIssueStatusSchema.optional(),
  })
  .strict();
export type ListMaterialIssuesQuery = z.infer<
  typeof ListMaterialIssuesQuerySchema
>;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

/**
 * Lightweight snapshot связанной потребности цеха, подгружаемый
 * вместе со строкой документа (см. service.ts::MATERIAL_ISSUE_DETAIL_INCLUDE).
 * Пригоден для inline-preview в карточке документа расхода, без
 * дополнительного запроса за `WorkshopNeed`.
 */
export interface MaterialIssueLineWorkshopNeedRefDto {
  id: string;
  description: string;
  materialRole: string | null;
  unit: string;
}

export interface MaterialIssueLineDto {
  id: string;
  workshopNeedId: string | null;
  workshopNeed: MaterialIssueLineWorkshopNeedRefDto | null;
  description: string;
  materialRole: string | null;
  unit: string;
  /** Decimal как строка (формат `Prisma.Decimal.toString()`). */
  issuedQty: string;
  unitCost: string;
  totalCost: string;
  cellId: string | null;
  cellCode: string | null;
  comment: string | null;
}

export interface MaterialIssueDetailDto {
  id: string;
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  passportId: string | null;
  passportNumber: string | null;
  status: MaterialIssueStatus | string;
  /**
   * Источник документа (`MANUAL` | `AUTO_CUT_ISSUE`). Frontend
   * не принимает это поле на вход — источник проставляет сервис.
   * См. `MATERIAL_ISSUE_SOURCES`.
   */
  source: MaterialIssueSource | string;
  /** Decimal как строка. */
  totalCost: string;
  createdAt: string;
  postedAt: string | null;
  cancelledAt: string | null;
  createdById: string | null;
  postedById: string | null;
  cancelledById: string | null;
  cancelReason: string | null;
  lines: MaterialIssueLineDto[];
}

/**
 * Компактный элемент списка `GET /api/material-issues` (+ вариант
 * `GET /api/orders/:orderId/material-issues`). Строки (`lines`)
 * приходят в базовой нормализации без `workshopNeed` / `cell` — это
 * достаточно для таблицы и preview-блока.
 */
export interface MaterialIssueListItemDto {
  id: string;
  orderId: string;
  orderNumber: string;
  passportId: string | null;
  passportNumber: string | null;
  status: MaterialIssueStatus | string;
  /**
   * Источник документа (`MANUAL` | `AUTO_CUT_ISSUE`). Сервер
   * отдаёт его в list-ответе, чтобы UI при желании мог отличать
   * автосписания от ручных документов без дополнительного fetch.
   */
  source: MaterialIssueSource | string;
  totalCost: string;
  createdAt: string;
  postedAt: string | null;
  cancelledAt: string | null;
  linesCount: number;
}
