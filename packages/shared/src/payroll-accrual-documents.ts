/**
 * Контракты модуля «PayrollAccrualDocument» — документ начисления
 * зарплаты на дату (PHASE 3 STEP 6).
 *
 * Источник истины — Prisma-модели `PayrollAccrualDocument` /
 * `PayrollAccrualDocumentLine` (`prisma/schema.prisma`,
 * [`docs/erd.md §2.9`](../../../docs/erd.md#29-salary--earnings)).
 *
 * Бизнес-смысл:
 *   - менеджер нажимает «Начислить зарплату» и указывает
 *     `accrualDate` (дату расчёта включительно);
 *   - система формирует `DRAFT`-документ со списком сотрудников
 *     и суммами к выплате: учитываются только `OperationEntry` /
 *     `SalaryEntry` с датой ≤ `accrualDate`;
 *   - менеджер может скорректировать суммы вручную (`manualAdjustRub`),
 *     добавить комментарий;
 *   - при переводе в `PAID` для каждой строки создаётся
 *     индивидуальный `PayrollPayout`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums (зеркало Prisma)
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл документа `PayrollAccrualDocument`. Валидные переходы:
 *
 *   - `DRAFT → PAID`      — менеджер провёл документ (созданы выплаты);
 *   - `DRAFT → CANCELLED` — менеджер отменил черновик.
 *
 * `PAID` и `CANCELLED` — терминальные.
 */
export const PAYROLL_ACCRUAL_DOCUMENT_STATUSES = [
  'DRAFT',
  'PAID',
  'CANCELLED',
] as const;
export const PayrollAccrualDocumentStatusSchema = z.enum(
  PAYROLL_ACCRUAL_DOCUMENT_STATUSES,
);
export type PayrollAccrualDocumentStatus = z.infer<
  typeof PayrollAccrualDocumentStatusSchema
>;

// ---------------------------------------------------------------------------
// Helpers (internal)
// ---------------------------------------------------------------------------

const DateOnlySchema = z
  .string()
  .min(1)
  .refine(
    (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
    { message: 'Дата в формате YYYY-MM-DD' },
  );

const OptionalCommentField = z
  .union([
    z
      .string()
      .trim()
      .max(2000, 'Комментарий слишком длинный')
      .transform((v) => (v.length === 0 ? null : v)),
    z.null(),
  ])
  .optional();

// ---------------------------------------------------------------------------
// Mutation schemas
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/payroll/accrual-documents`. Создаёт `DRAFT`-документ
 * начисления зарплаты на дату. Сервис формирует строки из начислений
 * `OperationEntry` / `SalaryEntry` с датой ≤ `accrualDate`.
 *
 * `employeeId` — опциональный фильтр по сотруднику. Если задан, документ
 * формируется только по этому сотруднику (одна строка). Не задан /
 * пустая строка → по всем сотрудникам с неоплаченными начислениями.
 */
export const CreatePayrollAccrualDocumentSchema = z.object({
  accrualDate: DateOnlySchema,
  employeeId: z
    .union([z.string().trim().min(1).max(40), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  managerComment: OptionalCommentField,
});
export type CreatePayrollAccrualDocumentDto = z.infer<
  typeof CreatePayrollAccrualDocumentSchema
>;

/**
 * Query `GET /api/payroll/accrual-documents`. Все фильтры опциональны.
 * `dateFrom` / `dateTo` сравниваются с `accrualDate` документа.
 */
export const PayrollAccrualDocumentListQuerySchema = z.object({
  status: PayrollAccrualDocumentStatusSchema.optional(),
  dateFrom: DateOnlySchema.optional(),
  dateTo: DateOnlySchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type PayrollAccrualDocumentListQuery = z.infer<
  typeof PayrollAccrualDocumentListQuerySchema
>;

/**
 * Тело `PATCH /api/payroll/accrual-documents/:id/lines/:lineId`.
 * Позволяет менеджеру скорректировать ручную корректировку суммы
 * и/или комментарий строки. Доступно только в статусе `DRAFT`.
 */
export const UpdatePayrollAccrualDocumentLineSchema = z.object({
  manualAdjustRub: z.number().optional(),
  manualComment: OptionalCommentField,
});
export type UpdatePayrollAccrualDocumentLineDto = z.infer<
  typeof UpdatePayrollAccrualDocumentLineSchema
>;

/**
 * Тело `POST /api/payroll/accrual-documents/:id/pay`. Проводит
 * документ: статус `DRAFT → PAID`, для каждой строки создаётся
 * индивидуальный `PayrollPayout`. `paidAt` / `paidById` фиксируются
 * сервисом.
 *
 * MVP: нет дополнительных полей — расширяемый пустой объект.
 */
export const PayPayrollAccrualDocumentSchema = z.object({}).strict();
export type PayPayrollAccrualDocumentDto = z.infer<
  typeof PayPayrollAccrualDocumentSchema
>;

/**
 * Тело `POST /api/payroll/accrual-documents/:id/cancel`. Отменяет
 * документ (`DRAFT → CANCELLED`). Опциональная причина пишется в
 * `cancelReason`.
 */
export const CancelPayrollAccrualDocumentSchema = z.object({
  reason: OptionalCommentField,
});
export type CancelPayrollAccrualDocumentDto = z.infer<
  typeof CancelPayrollAccrualDocumentSchema
>;

// ---------------------------------------------------------------------------
// Response DTO / view-models
// ---------------------------------------------------------------------------

/**
 * Минимальная информация о сотруднике, которую UI показывает
 * в строке документа начисления.
 */
export interface PayrollAccrualDocumentEmployeeDto {
  id: string;
  fullName: string;
  role: string;
}

/**
 * Строка документа начисления `PayrollAccrualDocumentLine`.
 * `snapshot` — свёрнутый JSON-вид начислений на момент формирования
 * строки; форма произвольная — `unknown`.
 * `payoutId` — заполняется после перевода документа в `PAID`.
 */
export interface PayrollAccrualDocumentLineDto {
  id: string;
  documentId: string;
  employeeId: string;
  employee: PayrollAccrualDocumentEmployeeDto;
  amountPieceworkRub: number;
  amountSalaryRub: number;
  manualAdjustRub: number;
  manualComment: string | null;
  amountToPayRub: number;
  payoutId: string | null;
  snapshot: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * Карточка документа начисления `PayrollAccrualDocument`. Денежные
 * значения — `number` (`Decimal(12,2)` приводится через `Number(...)`
 * на сервере). `lines` включаются только в детальный ответ
 * `GET /api/payroll/accrual-documents/:id`.
 */
export interface PayrollAccrualDocumentDto {
  id: string;
  /** ISO-дата без времени, `YYYY-MM-DD`. */
  accrualDate: string;
  status: PayrollAccrualDocumentStatus;
  /**
   * Сотрудник, по которому ограничен документ. `null` — документ
   * сформирован по всем сотрудникам.
   */
  employeeId: string | null;
  employee: PayrollAccrualDocumentEmployeeDto | null;
  totalPieceworkRub: number;
  totalSalaryRub: number;
  totalAdjustRub: number;
  totalToPayRub: number;
  managerComment: string | null;
  createdById: string;
  paidById: string | null;
  cancelledById: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  lines: PayrollAccrualDocumentLineDto[];
}

/**
 * Элемент списка документов начисления (без строк). Содержит
 * агрегированный счётчик строк `linesCount` вместо массива.
 */
export interface PayrollAccrualDocumentListItemDto {
  id: string;
  accrualDate: string;
  status: PayrollAccrualDocumentStatus;
  /** Сотрудник, по которому ограничен документ. `null` — по всем. */
  employeeId: string | null;
  employee: PayrollAccrualDocumentEmployeeDto | null;
  totalPieceworkRub: number;
  totalSalaryRub: number;
  totalAdjustRub: number;
  totalToPayRub: number;
  managerComment: string | null;
  createdAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  linesCount: number;
}

/** Страница списка документов начисления. */
export interface PayrollAccrualDocumentPageDto {
  items: PayrollAccrualDocumentListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}
