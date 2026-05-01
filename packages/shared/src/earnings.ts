/**
 * Контракты Шага 9 MVP: сдельные начисления (зарплата раскройщика и пошива).
 *
 * Zod-схемы — источник истины для валидации запросов на API и query-string
 * на web. `type`-алиасы выведены из схем, чтобы web и api жили на одних
 * и тех же DTO.
 *
 * Скоуп Шага 9:
 * - модель `OperationEntry` расширена двумя новыми измерениями:
 *   `approvalMode` (`IMMEDIATE` / `AFTER_RELEASE`) и `sourceEventType`
 *   (`PASSPORT_CREATED` / `OPERATION_TRANSITION`);
 * - автоматическое создание начислений в моменты `passport.create` и
 *   `passport.scanOnOperation` (см. `docs/flows.md §F2`, §F4);
 * - подтверждение `PENDING_RELEASE → APPROVED` в `packing.addPassport`
 *   (см. `docs/flows.md §F7`);
 * - минимальный API на просмотр (`/api/earnings`,
 *   `/api/earnings/summary`, `/api/passports/:id/earnings`);
 * - минимальный UI на `/earnings` и блок «Начисления» в карточке паспорта.
 *
 * За рамками Шага 9: расчёт окладов, ведомость за месяц, удержания за
 * брак по виновной операции, экспорт в Excel/PDF, интеграция с 1С/ЗУП,
 * сложные правила ревизии начислений, full audit UI, экран «Цех».
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Способ подтверждения сдельного начисления (см. ADR-0005).
 *
 * - `IMMEDIATE` — раскройщик: начисление сразу `APPROVED` при выпуске
 *   паспорта. Не зависит от дальнейшей судьбы партии.
 * - `AFTER_RELEASE` — пошив: начисление `PENDING_RELEASE` при переходе
 *   на следующую операцию, становится `APPROVED` только после упаковки.
 */
export const APPROVAL_MODES = ['IMMEDIATE', 'AFTER_RELEASE'] as const;
export const ApprovalModeSchema = z.enum(APPROVAL_MODES);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/**
 * Логический статус начисления, видимый снаружи. Совпадает с
 * `EntryStatus` из Prisma в части используемых на MVP значений.
 *
 * - `PENDING_RELEASE` — пошивное, ждёт упаковку;
 * - `APPROVED`       — подтверждено (раскройщик сразу, пошив после упаковки);
 * - `REVERSED`       — заложено для будущей отмены упаковки/возврата
 *   паспорта в производство, на MVP не выставляется (см. ADR-0012).
 */
export const EARNING_STATUSES = [
  'PENDING_RELEASE',
  'APPROVED',
  'REVERSED',
] as const;
export const EarningStatusSchema = z.enum(EARNING_STATUSES);
export type EarningStatus = z.infer<typeof EarningStatusSchema>;

/**
 * Дискриминатор источника начисления. Используется как часть составного
 * ключа идемпотентности (см. ADR-0012).
 */
export const EARNING_SOURCES = [
  'PASSPORT_CREATED',
  'OPERATION_TRANSITION',
] as const;
export const EarningSourceSchema = z.enum(EARNING_SOURCES);
export type EarningSource = z.infer<typeof EarningSourceSchema>;

// ---------------------------------------------------------------------------
// Query DTO
// ---------------------------------------------------------------------------

const DateStringSchema = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'Некорректная дата',
  });

/**
 * Query `GET /api/earnings`.
 *
 * Все фильтры опциональны; пустые строки воспринимаются как «не задано».
 * `dateFrom/dateTo` — ISO-строки даты или datetime; на сервере
 * сравниваются с `OperationEntry.createdAt`.
 */
export const ListEarningsQuerySchema = z.object({
  employeeId: z.string().min(1).optional(),
  passportId: z.string().min(1).optional(),
  status: EarningStatusSchema.optional(),
  approvalMode: ApprovalModeSchema.optional(),
  dateFrom: DateStringSchema.optional(),
  dateTo: DateStringSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type ListEarningsQuery = z.infer<typeof ListEarningsQuerySchema>;

/** Query `GET /api/earnings/summary`. */
export const EarningsSummaryQuerySchema = z.object({
  employeeId: z.string().min(1).optional(),
  dateFrom: DateStringSchema.optional(),
  dateTo: DateStringSchema.optional(),
});
export type EarningsSummaryQuery = z.infer<typeof EarningsSummaryQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTO / view-models
// ---------------------------------------------------------------------------

/**
 * Одна строка начисления. Денежные значения возвращаются как `number`
 * (Decimal приводится через `Number(...)`): на MVP суммы небольшие и
 * влезают в безопасный диапазон. Округление — до двух знаков.
 */
export interface EarningDto {
  id: string;
  passportId: string;
  passportNumber: string;
  orderId: string;
  orderNumber: string;
  productName: string;
  color: string;
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  operationId: string;
  operationCode: string;
  operationName: string;
  employeeId: string;
  employeeFullName: string;
  qty: number;
  ratePerUnit: number;
  amount: number;
  status: EarningStatus;
  approvalMode: ApprovalMode;
  sourceEventType: EarningSource;
  createdAt: string; // ISO
  approvedAt: string | null; // ISO
}

export interface EarningsPage {
  items: EarningDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EarningsSummaryDto {
  /** Σ amount у всех `APPROVED`, попавших в фильтр. */
  totalApproved: number;
  /** Σ amount у всех `PENDING_RELEASE`, попавших в фильтр. */
  totalPending: number;
  countApproved: number;
  countPending: number;
}
