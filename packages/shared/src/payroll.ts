/**
 * Контракты модуля «Payroll» (PHASE 1, read-only).
 *
 * Это **управленческий просмотровый агрегатор** поверх уже работающих
 * сдельного и окладного контуров:
 *
 *   - источник истины сдельных начислений — `OperationEntry`
 *     (`apps/api/src/modules/earnings/*`, см.
 *     `docs/domain.md §10.2`);
 *   - источник истины окладных начислений — `SalaryEntry`
 *     (`apps/api/src/modules/salary/*`, см.
 *     `docs/domain.md §10.3`);
 *   - источник истины смены — `ShiftSession`
 *     (`apps/api/src/modules/shifts/*`).
 *
 * PHASE 1 запретила менять модель начислений, lifecycle статусов,
 * `PackingService.close` и `EarningsService` / `SalaryService` ядро.
 * Сюда попадает только новый read-only сервис, который **не пишет в
 * БД** — только агрегирует. Legacy-поля `Employee.salaryBase` и
 * таблица `PieceRate` удалены в PHASE 2 STEP 1.
 *
 * Менеджер видит:
 *
 *   - `/api/payroll/period`           — ведомость по сотрудникам за период;
 *   - `/api/payroll/daily`            — снимок «кто работал сегодня»;
 *   - `/api/payroll/employees/:id`    — карточка сотрудника с деталями.
 *
 * RBAC: `SHOP_MANAGER`, `ADMIN`. Все остальные роли по-прежнему ходят
 * за личной зарплатой через старый `/api/earnings` и `/api/salary` —
 * payroll API сознательно ограничен ролями менеджера, чтобы рабочие
 * экраны не получали лишних агрегатов.
 *
 * Связанные документы:
 *   - `docs/api.md §31a`, `docs/domain.md §10.6`, `docs/screens.md §12a`,
 *     `docs/erd.md §2.9`, `docs/events.md §3.3` (read-only, AuditLog
 *     не пишется).
 */

import { z } from 'zod';
import {
  CompensationTypeSchema,
  type CompensationType,
  type SalaryRateMode,
} from './employees';
import type { SalaryEntrySource } from './salary';
import {
  EarningStatusSchema,
  type EarningStatus,
  type ApprovalMode,
  type EarningSource,
} from './earnings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DateOnlySchema = z
  .string()
  .min(1)
  .refine(
    (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
    {
      message: 'Дата в формате YYYY-MM-DD',
    },
  );

// ---------------------------------------------------------------------------
// Query DTO
// ---------------------------------------------------------------------------

/**
 * Query `GET /api/payroll/period`.
 *
 * `dateFrom`/`dateTo` — обязательные, чтобы менеджер не получил
 * случайно ведомость «за всё время» с десятками тысяч строк. Период
 * включает обе даты (`>=`, `<=`).
 *
 * Все остальные фильтры опциональны:
 *
 * - `employeeId` — конкретный сотрудник (обычно для drill-down);
 * - `role` — `Employee.role` строкой (без enum-ограничения, чтобы
 *   будущие роли не ломали валидацию);
 * - `divisionCode` — `CompanyDivision.code` (фильтр работает по
 *   подразделению заказа, к которому привязан паспорт начисления);
 * - `status` — фильтр по сдельной части: `APPROVED` /
 *   `PENDING_RELEASE` (см. `EarningStatus` в `earnings.ts`).
 *   Окладная часть статусом не фильтруется — у `SalaryEntry`
 *   нет lifecycle-статусов.
 * - `page` / `pageSize` — пагинация по сотрудникам.
 */
export const PayrollPeriodQuerySchema = z.object({
  dateFrom: DateOnlySchema,
  dateTo: DateOnlySchema,
  employeeId: z.string().min(1).optional(),
  role: z.string().min(1).max(64).optional(),
  divisionCode: z.string().min(1).max(64).optional(),
  status: EarningStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type PayrollPeriodQuery = z.infer<typeof PayrollPeriodQuerySchema>;

/**
 * Query `GET /api/payroll/daily`.
 *
 * `date` — обязательна. Сравнивается как локальная календарная дата
 * (`>= startOfDay(date) && <= endOfDay(date)`), идентично
 * `SalaryService.syncDailySalary`.
 */
export const PayrollDailyQuerySchema = z.object({
  date: DateOnlySchema,
  role: z.string().min(1).max(64).optional(),
  divisionCode: z.string().min(1).max(64).optional(),
});
export type PayrollDailyQuery = z.infer<typeof PayrollDailyQuerySchema>;

/**
 * Query `GET /api/payroll/employees/:id`.
 *
 * Менеджерская drill-down карточка: смены, сдельные начисления и
 * окладные начисления одного сотрудника за период. Период
 * обязательный по той же причине, что и в periodQuery.
 */
export const PayrollEmployeeQuerySchema = z.object({
  dateFrom: DateOnlySchema,
  dateTo: DateOnlySchema,
});
export type PayrollEmployeeQuery = z.infer<typeof PayrollEmployeeQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

/**
 * Одна строка ведомости — один сотрудник за период.
 *
 * Все денежные значения приведены к `number` через `Number(decimal)`
 * (округление до 2 знаков на сервере). Семантика полей:
 *
 *   - `pieceworkApprovedRub` — Σ `OperationEntry.amount` со
 *     `status = APPROVED` за период (по `createdAt`);
 *   - `pieceworkPendingRub`  — Σ `OperationEntry.amount` со
 *     `status = PENDING_RELEASE` (legacy `PENDING` сюда же);
 *   - `salaryRub`            — Σ `SalaryEntry.amount` за период
 *     (по `date`);
 *   - `salaryEditedRub`      — Σ `SalaryEntry.amount` среди тех
 *     записей, у которых `editedManually = true` (для KPI «сколько
 *     отредактировано вручную», подсветка для аудита);
 *   - `totalApprovedRub`     — `pieceworkApprovedRub + salaryRub`;
 *   - `totalPendingRub`      — `pieceworkPendingRub`;
 *   - `totalRub`             — `totalApprovedRub + totalPendingRub`;
 *   - `daysOnShift`          — количество уникальных дней, в которые
 *     у сотрудника была хотя бы одна `ShiftSession.startedAt` в
 *     периоде. Не «закрытые смены» — а именно «дней со сменой»,
 *     совпадает с правилом `SalaryService.syncDailySalary`;
 *   - `entriesCount`         — `OperationEntry` count за период
 *     (для UI «сколько строк сдельщины»).
 *
 * `companyDivisionId` / `companyDivision` — попытка показать
 * «основное подразделение сотрудника» через большинство паспортов
 * его сдельных начислений за период; для окладных ролей и для
 * сотрудников без сдельщины поле остаётся `null` (UNKNOWN/TODO).
 */
export interface PayrollPeriodEmployeeRowDto {
  employeeId: string;
  fullName: string;
  role: string;
  compensationType: CompensationType;
  companyDivisionId: string | null;
  companyDivision: string | null;
  pieceworkApprovedRub: number;
  pieceworkPendingRub: number;
  salaryRub: number;
  salaryEditedRub: number;
  totalApprovedRub: number;
  totalPendingRub: number;
  totalRub: number;
  daysOnShift: number;
  entriesCount: number;
  /**
   * Gross начислено (approved) за период: `pieceworkApprovedRub + salaryRub`.
   * Pending сдельщина (`pieceworkPendingRub`) НЕ входит: пока не
   * утверждена, в выплату не берётся.
   */
  grossAccruedRub: number;
  /**
   * Σ сумм `PayrollPayoutLine`, привязанных к начислениям этого
   * сотрудника за выбранный период и относящихся к активным выплатам
   * (`PayrollPayout.status ∈ {DRAFT, ISSUED, ACKNOWLEDGED}`).
   * `CANCELLED` не учитывается.
   */
  payoutCoveredRub: number;
  /**
   * Часть `payoutCoveredRub` от строк `kind = PIECEWORK`.
   */
  payoutPieceworkCoveredRub: number;
  /**
   * Часть `payoutCoveredRub` от строк `kind = SALARY`.
   */
  payoutSalaryCoveredRub: number;
  /**
   * Остаток к выплате прямо сейчас:
   * `max(0, grossAccruedRub − payoutCoveredRub)`.
   */
  netToPayRub: number;
  /**
   * Σ сумм `PayrollPayoutLine` с `kind ∈ {ADJUSTMENT, BONUS, DEDUCTION, ADVANCE}`
   * по активным выплатам сотрудника за период (STEP 6.4).
   * Не входит в `payoutCoveredRub` и не влияет на `netToPayRub`.
   */
  payoutAdjustRub: number;
}

export interface PayrollPeriodSummaryDto {
  /** Σ `pieceworkApprovedRub + salaryRub` по всем сотрудникам периода. */
  totalApprovedRub: number;
  /** Σ `pieceworkPendingRub` по всем сотрудникам периода. */
  totalPendingRub: number;
  /** Σ `totalRub` по всем сотрудникам периода. */
  totalRub: number;
  /** Σ `pieceworkApprovedRub` + `pieceworkPendingRub`. */
  pieceworkRub: number;
  /** Σ `salaryRub`. */
  salaryRub: number;
  /** Σ `salaryEditedRub`. */
  salaryEditedRub: number;
  employeesCount: number;
  pieceworkEntriesCount: number;
  pieceworkPendingCount: number;
  salaryEntriesCount: number;
  salaryEditedCount: number;
  /** Σ `payoutCoveredRub` — сколько суммарно уже в активных выплатах. */
  totalPayoutCoveredRub: number;
  /** Σ `netToPayRub` — суммарный остаток к выплате сейчас. */
  totalNetToPayRub: number;
}

export interface PayrollPeriodPageDto {
  items: PayrollPeriodEmployeeRowDto[];
  summary: PayrollPeriodSummaryDto;
  /** Эхо-период (`dateFrom` / `dateTo` из запроса). */
  dateFrom: string;
  dateTo: string;
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Одна строка дневного снимка `/api/payroll/daily`.
 *
 * Сюда попадают все сотрудники, у которых:
 *   - была `ShiftSession` за выбранный день, ИЛИ
 *   - была `SalaryEntry.date = date`, ИЛИ
 *   - был `OperationEntry.createdAt` в этот день.
 *
 * `hadShift` отдельный флаг — менеджер видит «у кого реально была
 * смена», а не просто «кому начислили». `shiftStartedAt`/
 * `shiftStoppedAt` — первая открытая (или последняя закрытая) смена
 * за день; если их не было, оба поля `null`.
 */
export interface PayrollDailyEmployeeRowDto {
  employeeId: string;
  fullName: string;
  role: string;
  compensationType: CompensationType;
  hadShift: boolean;
  shiftStartedAt: string | null;
  shiftStoppedAt: string | null;
  pieceworkApprovedRub: number;
  pieceworkPendingRub: number;
  salaryRub: number;
  totalRub: number;
}

export interface PayrollDailySummaryDto {
  employeesCount: number;
  shiftsCount: number;
  totalRub: number;
  pieceworkApprovedRub: number;
  pieceworkPendingRub: number;
  salaryRub: number;
}

export interface PayrollDailyPageDto {
  date: string;
  employees: PayrollDailyEmployeeRowDto[];
  summary: PayrollDailySummaryDto;
}

/**
 * Карточка сотрудника `/api/payroll/employees/:id`.
 *
 * Базовые поля сотрудника + summary за период + отдельные списки
 * `shifts[]`, `operationEntries[]`, `salaryEntries[]`. PHASE 1 не
 * страничит эти списки — карточка живёт в управленческом окне на
 * одного сотрудника, объёмы небольшие.
 */
export interface PayrollEmployeeDetailEmployeeDto {
  employeeId: string;
  fullName: string;
  login: string;
  role: string;
  compensationType: CompensationType;
  /**
   * Вид окладной ставки (`Employee.salaryRateMode`, 29.07.2026).
   * Опционально ради backward-compat; backend всегда отдаёт ключ.
   */
  salaryRateMode?: SalaryRateMode;
  /** Почасовая ставка `Employee.salaryPerHour` (₽/час). */
  salaryPerHour: number | null;
  /** Месячный оклад `Employee.salaryPerMonth` (₽/мес). */
  salaryPerMonth?: number | null;
  active: boolean;
  /**
   * PHASE 2 STEP 2: подразделение, к которому привязан сотрудник
   * (`Employee.companyDivisionId`). Используется UI карточки
   * `/admin/payroll/employees/[id]` для шапки.
   *
   * Опционально на уровне типа (`?`) ради backward-compat: старые
   * потребители без пересборки shared-пакета продолжают
   * компилироваться. Backend всегда возвращает оба ключа.
   */
  companyDivisionId?: string | null;
  companyDivision?: { id: string; code: string; name: string } | null;
}

export interface PayrollEmployeeShiftDto {
  id: string;
  startedAt: string;
  endedAt: string | null;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  operationId: string;
  operationCode: string;
  operationName: string;
}

export interface PayrollEmployeeOperationEntryDto {
  id: string;
  passportId: string;
  passportNumber: string;
  orderId: string;
  orderNumber: string;
  operationId: string;
  operationCode: string;
  operationName: string;
  qty: number;
  ratePerUnit: number;
  amount: number;
  status: EarningStatus;
  approvalMode: ApprovalMode;
  sourceEventType: EarningSource;
  createdAt: string;
  approvedAt: string | null;
}

export interface PayrollEmployeeSalaryEntryDto {
  id: string;
  date: string;
  amount: number;
  /**
   * Отработанные секунды. Для `SHIFT_DAY`/`RECUT` — за день, для
   * `MONTH_SALARY` — за весь месяц (справочно, сумма от них не
   * зависит). `null` — историч./MANUAL.
   */
  workedSeconds: number | null;
  source: SalaryEntrySource;
  editedManually: boolean;
  managerComment: string | null;
  editedByEmployeeId: string | null;
  editedByFullName: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Debts query / DTO (PHASE 3 STEP 7)
// ---------------------------------------------------------------------------

/**
 * Query `GET /api/payroll/debts`.
 *
 * `asOfDate` — включительная дата среза. Если не передана — используется
 * сегодняшний день. Формат `YYYY-MM-DD`.
 *
 * Остальные фильтры совпадают по семантике с `PayrollPeriodQuerySchema`:
 * `employeeId`, `role`, `divisionCode` — опциональные уточнители.
 */
export const PayrollDebtsQuerySchema = z.object({
  asOfDate: DateOnlySchema.optional(),
  employeeId: z.string().min(1).optional(),
  role: z.string().min(1).max(64).optional(),
  divisionCode: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type PayrollDebtsQuery = z.infer<typeof PayrollDebtsQuerySchema>;

/**
 * Одна строка управленческого отчёта задолженности — один сотрудник.
 *
 * Формулы (asOfDate inclusive):
 *   - `accruedGrossRub`       = `accruedPieceworkRub + accruedSalaryRub`
 *   - `payoutCoveredRub`      = Σ PIECEWORK/SALARY PayrollPayoutLine,
 *                               ссылающихся на начисления до asOfDate,
 *                               по активным выплатам (DRAFT/ISSUED/ACKNOWLEDGED)
 *   - `payoutAdjustRub`       = Σ BONUS/DEDUCTION/ADVANCE/ADJUSTMENT lines
 *                               по активным выплатам, payout.periodTo <= asOfDate
 *   - `paidTotalRub`          = `payoutCoveredRub + payoutAdjustRub`
 *   - `debtRub`               = `max(0, accruedGrossRub − payoutCoveredRub)`
 *   - `cashBalanceRub`        = `accruedGrossRub − paidTotalRub`
 *   - `pendingPieceworkRub`   = Σ OperationEntry(PENDING_RELEASE|PENDING) до asOfDate;
 *                               НЕ входит в debtRub
 *
 * Важно: `debtRub` отражает именно «долг по базовым начислениям» — без
 * корректировок. `cashBalanceRub` учитывает корректировки. Оба поля нужны:
 *   - `debtRub`         — «сколько ещё не закрыто PIECEWORK/SALARY»;
 *   - `cashBalanceRub`  — «сколько денег реально на руках у сотрудника
 *                          с учётом бонусов/удержаний».
 */
export interface PayrollDebtEmployeeRowDto {
  employeeId: string;
  fullName: string;
  role: string;
  companyDivisionId: string | null;
  companyDivisionName: string | null;

  /** Σ approved OperationEntry.amount до asOfDate. */
  accruedPieceworkRub: number;
  /** Σ SalaryEntry.amount до asOfDate. */
  accruedSalaryRub: number;
  /** `accruedPieceworkRub + accruedSalaryRub`. */
  accruedGrossRub: number;

  /** Σ PIECEWORK PayrollPayoutLine по активным выплатам (до asOfDate). */
  payoutCoveredPieceworkRub: number;
  /** Σ SALARY PayrollPayoutLine по активным выплатам (до asOfDate). */
  payoutCoveredSalaryRub: number;
  /** `payoutCoveredPieceworkRub + payoutCoveredSalaryRub`. */
  payoutCoveredRub: number;

  /** Σ BONUS/DEDUCTION/ADVANCE/ADJUSTMENT lines по активным выплатам (до asOfDate). */
  payoutAdjustRub: number;

  /** `payoutCoveredRub + payoutAdjustRub`. */
  paidTotalRub: number;
  /** `max(0, accruedGrossRub − payoutCoveredRub)`. Базовый долг без корректировок. */
  debtRub: number;
  /** `accruedGrossRub − paidTotalRub`. Остаток с учётом корректировок. */
  cashBalanceRub: number;

  /** Σ pending OperationEntry.amount до asOfDate. Не входит в debtRub. */
  pendingPieceworkRub: number;
  /** Дата последней активной выплаты (issuedAt или createdAt). */
  lastPayoutAt: string | null;
  /** Дата последнего ACK сотрудника по активным выплатам. */
  lastAcknowledgedAt: string | null;
}

export interface PayrollDebtsSummaryDto {
  totalAccruedGrossRub: number;
  totalPayoutCoveredRub: number;
  totalPayoutAdjustRub: number;
  totalPaidRub: number;
  totalDebtRub: number;
  totalCashBalanceRub: number;
  totalPendingPieceworkRub: number;
  /** Количество сотрудников с `debtRub > 0`. */
  employeesWithDebt: number;
}

export interface PayrollDebtsPageDto {
  items: PayrollDebtEmployeeRowDto[];
  summary: PayrollDebtsSummaryDto;
  /** Дата среза (YYYY-MM-DD). */
  asOfDate: string;
  total: number;
  page: number;
  pageSize: number;
}

export interface PayrollEmployeeDetailDto {
  employee: PayrollEmployeeDetailEmployeeDto;
  /** Эхо-период. */
  dateFrom: string;
  dateTo: string;
  summary: {
    pieceworkApprovedRub: number;
    pieceworkPendingRub: number;
    salaryRub: number;
    salaryEditedRub: number;
    totalApprovedRub: number;
    totalPendingRub: number;
    totalRub: number;
    daysOnShift: number;
    entriesCount: number;
  };
  shifts: PayrollEmployeeShiftDto[];
  operationEntries: PayrollEmployeeOperationEntryDto[];
  salaryEntries: PayrollEmployeeSalaryEntryDto[];
}
