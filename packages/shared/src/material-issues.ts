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

/**
 * Ограничения reason для возврата (`POST /api/material-issues/:id/return`).
 * `min(2)` — иначе UI получит «бесполезные» возвраты с пустыми
 * комментариями, и журнал теряет смысл; `max(500)` — просто чтобы
 * не дать клиенту положить слишком длинный текст в `reason`.
 */
export const MATERIAL_ISSUE_RETURN_REASON_MIN_LENGTH = 2;
export const MATERIAL_ISSUE_RETURN_REASON_MAX_LENGTH = 500;
/**
 * Длина опционального `clientRequestId` (UI-форма генерит UUID,
 * максимум — обычно 36, но допускаем чуть больше).
 */
export const MATERIAL_ISSUE_RETURN_CLIENT_REQUEST_ID_MAX_LENGTH = 128;

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
// Return DTO (полное сторно проведённого расхода)
// ---------------------------------------------------------------------------

/**
 * Одна строка частичного возврата в теле
 * `POST /api/material-issues/:id/return` (см.
 * `apps/api/src/modules/material-issues/dto/return-material-issue.dto.ts`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts::returnPostedIssue`).
 *
 * `materialIssueLineId` ОБЯЗАТЕЛЬНО принадлежит исходному документу
 * (валидируется на сервере 409). `returnedQty > 0` — строки с `0`
 * UI обязан фильтровать ДО submit, иначе Zod вернёт 400.
 */
export const ReturnMaterialIssueLineSchema = z
  .object({
    materialIssueLineId: trimmedString(64),
    returnedQty: positiveDecimal,
  })
  .strict();
export type ReturnMaterialIssueLineDto = z.infer<
  typeof ReturnMaterialIssueLineSchema
>;

/**
 * Body для `POST /api/material-issues/:id/return` (см.
 * `apps/api/src/modules/material-issues/dto/return-material-issue.dto.ts`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts::returnPostedIssue`).
 *
 * Два режима:
 *   - **Полное сторно** — `lines` не передан (или undefined). Сервис
 *     возвращает весь оставшийся остаток (`MaterialIssueLine.issuedQty −
 *     Σ ранее возвращённое`) по каждой строке. Это исходное MVP-
 *     поведение, оставлено ради обратной совместимости.
 *   - **Частичный возврат** — `lines` передан (≥ 1 элемент). Сервис
 *     возвращает только указанные `materialIssueLineId × returnedQty`,
 *     каждый `returnedQty` ≤ `availableToReturn` (исходное
 *     `issuedQty` − уже возвращённое); duplicate `materialIssueLineId`
 *     запрещены (409). Строка с `returnedQty = 0` НЕ принимается DTO
 *     (`positiveDecimal`), UI обязан фильтровать нулевые строки.
 *
 * `clientRequestId` (UUID v4 от UI) — UNIQUE-ключ идемпотентности,
 * защита от двойного submit формы (см.
 * `MaterialIssueReturn.sourceKey`).
 */
export const ReturnMaterialIssueSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(MATERIAL_ISSUE_RETURN_REASON_MIN_LENGTH)
      .max(MATERIAL_ISSUE_RETURN_REASON_MAX_LENGTH),
    clientRequestId: z
      .string()
      .trim()
      .min(1)
      .max(MATERIAL_ISSUE_RETURN_CLIENT_REQUEST_ID_MAX_LENGTH)
      .optional(),
    lines: z
      .array(ReturnMaterialIssueLineSchema)
      .min(1, 'Нужна хотя бы одна строка возврата')
      .optional(),
  })
  .strict();
export type ReturnMaterialIssueDto = z.infer<typeof ReturnMaterialIssueSchema>;

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
  /**
   * Σ `MaterialIssueReturnLine.returnedQty` по `POSTED`
   * `MaterialIssueReturn`-ам, ссылающимся на эту строку расхода.
   * Decimal-as-string. `'0'`, если возвратов нет (см.
   * `apps/api/src/modules/material-issues/material-issues.service.ts::computeLineNetAggregates`).
   */
  returnedQty: string;
  /**
   * Σ `MaterialIssueReturnLine.totalCost` (документная стоимость
   * возврата) по `POSTED` возвратам этой строки. `'0'`, если
   * возвратов нет.
   */
  returnedTotalCost: string;
  /**
   * `issuedQty − returnedQty`. Может быть `'0'` (полностью
   * возвращено), но не отрицательным — backend гарантирует, что
   * сумма возвратов не превышает выданное.
   */
  netIssuedQty: string;
  /** `totalCost − returnedTotalCost`. */
  netTotalCost: string;
}

/**
 * Жизненный цикл возврата `MaterialIssueReturn`. На MVP всегда
 * `POSTED`, но клиент должен принимать любую строку (расширение
 * списка не требует миграции — `prisma/schema.prisma::MaterialIssueReturn.status`
 * хранится как `String`).
 */
export const MATERIAL_ISSUE_RETURN_STATUSES = ['POSTED'] as const;
export type MaterialIssueReturnStatus =
  (typeof MATERIAL_ISSUE_RETURN_STATUSES)[number];

/**
 * Совокупный статус возвратов по проведённому `MaterialIssue`,
 * который видит UI на блоке «Фактический расход материалов»:
 *
 *   - `NONE`    — возвратов ещё нет;
 *   - `PARTIAL` — какие-то строки возвращены частично или
 *                 полностью, но остаток ещё не нулевой;
 *   - `FULL`    — все строки полностью возвращены, остатка нет —
 *                 кнопка «Сторнировать» уже не показывается.
 */
export const MATERIAL_ISSUE_RETURN_STATUSES_AGG = [
  'NONE',
  'PARTIAL',
  'FULL',
] as const;
export type MaterialIssueAggregateReturnStatus =
  (typeof MATERIAL_ISSUE_RETURN_STATUSES_AGG)[number];

export interface MaterialIssueReturnLineDto {
  id: string;
  materialIssueLineId: string;
  workshopNeedId: string | null;
  description: string;
  materialRole: string | null;
  unit: string;
  /** Decimal-as-string. */
  returnedQty: string;
  unitCost: string;
  totalCost: string;
  cellId: string | null;
  cellCode: string | null;
  comment: string | null;
}

export interface MaterialIssueReturnDto {
  id: string;
  materialIssueId: string;
  orderId: string;
  passportId: string | null;
  status: MaterialIssueReturnStatus | string;
  reason: string;
  /** Σ `MaterialIssueReturnLine.totalCost` (Decimal-as-string). */
  totalCost: string;
  createdAt: string;
  createdById: string | null;
  lines: MaterialIssueReturnLineDto[];
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
  /**
   * Документы возврата по этому проведённому `MaterialIssue`
   * (только `POSTED`). Пустой массив, если возвратов нет. Detail-
   * уровень — UI рендерит «Сторнирован» / «Частичный возврат» по
   * `returnStatus` без дополнительного fetch.
   */
  returns: MaterialIssueReturnDto[];
  /** Σ `MaterialIssueReturn.totalCost` (POSTED). Decimal-as-string. */
  returnedTotalCost: string;
  /** `totalCost − returnedTotalCost`. Decimal-as-string. */
  netTotalCost: string;
  /** Совокупный статус возвратов: `NONE` | `PARTIAL` | `FULL`. */
  returnStatus: MaterialIssueAggregateReturnStatus;
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
  /**
   * Σ `MaterialIssueReturn.totalCost` (POSTED) по этому документу.
   * Decimal-as-string. `'0'`, если возвратов нет — UI не делает
   * различий «нет возвратов» / «явный 0», но строка всё равно
   * приходит, чтобы сводка по списку считалась без второго fetch.
   */
  returnedTotalCost: string;
  /** `totalCost − returnedTotalCost`. Decimal-as-string. */
  netTotalCost: string;
  /** Сколько возвратов прошло (POSTED `MaterialIssueReturn` count). */
  returnsCount: number;
  /** Совокупный статус: `NONE` | `PARTIAL` | `FULL`. */
  returnStatus: MaterialIssueAggregateReturnStatus;
}
