/**
 * Контракты «Статистика по сотрудникам» для кабинета мастера
 * (`apps/api/src/modules/master-employee-stats/*`, вкладка «Сотрудники»
 * в `apps/web/app/master`).
 *
 * Назначение: дать `SHOPFLOOR_MASTER` (и `SHOP_MANAGER` / `ADMIN`)
 * сводку «кто сколько сделал» за произвольный период. Таблица —
 * строка = сотрудник, колонки = его операции + итоги; провал в строку →
 * полная разбивка по операциям и по дням.
 *
 * Источник «сделанного» — события `PassportEvent.type =
 * OPERATION_FINISHED` (см. memory `project_no_operation_scan_events`:
 * реальный флоу = `ISSUED_TO_EMPLOYEE → OPERATION_FINISHED` без SCAN).
 * Это универсальная метка «операция закрыта» для ЛЮБОГО типа оплаты
 * (сдельщина/оклад) — в отличие от `OperationEntry`, который есть только
 * у сдельных. Считаем по `OPERATION_FINISHED.employeeId`:
 *   - `qty` штук = Σ `PassportEvent.qty` (он = `Passport.qtyGood` на
 *     момент закрытия операции);
 *   - паспортов = число РАЗНЫХ `passportId`;
 *   - операций = число самих событий `OPERATION_FINISHED` (один акт
 *     закрытия операции; rework по той же паре даёт второй акт).
 *
 * Брак (`defects`) атрибутируется ИСПОЛНИТЕЛЮ операции, а не тому, кто
 * его зафиксировал. `DEFECT_RECORDED` привязан к `(passportId,
 * operationId)`; владелец брака = сотрудник, закрывший эту же пару
 * `OPERATION_FINISHED` (последний финишёр). Семантика — «брак, найденный
 * на операциях, которые закрыл сотрудник». Окно брака — по
 * `DEFECT_RECORDED.createdAt` (день фиксации), финиш ищется без окна.
 *
 * Окно периода выработки — по `OPERATION_FINISHED.createdAt`. Период
 * задаёт сам мастер (`from`/`to`, UTC-`YYYY-MM-DD`), без фиксированных
 * 7/14/30; по умолчанию UI стартует с одного дня (сегодня).
 * Статистика — read-only (сервис только агрегирует).
 *
 * Вторая часть вкладки — режим «Активные» (`MasterActiveShift*`):
 * список открытых смен (`ShiftSession.endedAt = null`) прямо сейчас
 * плюс единственная мутация — принудительное завершение смены мастером
 * (сотрудники забывают закрываться сами).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Период статистики по сотрудникам — произвольный диапазон по дате
 * закрытия операции (`OPERATION_FINISHED.createdAt`, UTC-день).
 * `from`/`to` включительны: `to` разворачивается в конец дня на бэке.
 */
export const MasterEmployeeStatsQuerySchema = z.object({
  from: z.string().regex(DAY_RE),
  to: z.string().regex(DAY_RE),
});
export type MasterEmployeeStatsQuery = z.infer<
  typeof MasterEmployeeStatsQuerySchema
>;

/** Тот же период + конкретный сотрудник (провал в строку таблицы). */
export const MasterEmployeeStatsDrillQuerySchema =
  MasterEmployeeStatsQuerySchema.extend({
    employeeId: z.string().min(1),
  });
export type MasterEmployeeStatsDrillQuery = z.infer<
  typeof MasterEmployeeStatsDrillQuerySchema
>;

// ---------------------------------------------------------------------------
// Response: list
// ---------------------------------------------------------------------------

export interface MasterEmployeeOpStatDto {
  operationId: string;
  operationCode: string;
  operationName: string;
  /** Разных паспортов, закрытых сотрудником на этой операции. */
  passports: number;
  /** Σ `qty` (штук) по этой операции. */
  qty: number;
  /** Σ брака (`DEFECT_RECORDED.qty`), найденного на этой операции. */
  defects: number;
}

export interface MasterEmployeeStatRowDto {
  employeeId: string;
  employeeName: string;
  /** `Employee.role` (enum) — UI вешает свою подпись. */
  role: string;
  /** Разных паспортов, которых касался сотрудник (по всем операциям). */
  totalPassports: number;
  /** Σ `qty` (штук) по всем операциям. */
  totalQty: number;
  /** Σ брака, найденного на операциях этого сотрудника за период. */
  totalDefects: number;
  /** Число актов закрытия операции (`OPERATION_FINISHED`). */
  totalOperations: number;
  /**
   * Разбивка по операциям, отсортирована по `qty` убыв. Список короткий
   * (типов операций немного) — UI показывает топ-N как «операции
   * сотрудника» и полный список при провале.
   */
  operations: MasterEmployeeOpStatDto[];
}

export interface MasterEmployeeStatsDto {
  /** UTC-`YYYY-MM-DD`, эхо запроса. */
  from: string;
  to: string;
  /** Сотрудники с ≥1 закрытой операцией в периоде, по `totalQty` убыв. */
  rows: MasterEmployeeStatRowDto[];
}

// ---------------------------------------------------------------------------
// Response: drill (провал в одного сотрудника)
// ---------------------------------------------------------------------------

export interface MasterEmployeeDayStatDto {
  /** UTC-`YYYY-MM-DD`. */
  day: string;
  passports: number;
  qty: number;
  defects: number;
  operations: number;
}

export interface MasterEmployeeDrillDto {
  employeeId: string;
  employeeName: string;
  role: string;
  from: string;
  to: string;
  totalPassports: number;
  totalQty: number;
  totalDefects: number;
  totalOperations: number;
  /** Полная разбивка по операциям, по `qty` убыв. */
  operations: MasterEmployeeOpStatDto[];
  /** Выработка по дням, новые сверху. */
  byDay: MasterEmployeeDayStatDto[];
}

// ---------------------------------------------------------------------------
// Активные смены (режим «Активные» вкладки «Сотрудники»)
// ---------------------------------------------------------------------------

/**
 * Одна открытая смена (`ShiftSession.endedAt = null`) для режима
 * «Активные»: сотрудники забывают закрывать смены, мастер видит список
 * «кто открыт прямо сейчас» и может принудительно завершить смену
 * (`POST /api/master/employee-stats/active-shifts/:shiftId/close`).
 */
export interface MasterActiveShiftDto {
  shiftId: string;
  employeeId: string;
  employeeName: string;
  /** `Employee.role` (enum) — UI вешает свою подпись. */
  role: string;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  /** Крупный номер стола для цеха (`Equipment.displayNumber`). */
  equipmentDisplayNumber: string | null;
  operationId: string;
  operationName: string;
  /** ISO-8601, момент открытия смены. */
  startedAt: string;
  /**
   * Паспортов `IN_PROGRESS` на руках у сотрудника прямо сейчас
   * (`Passport.currentEmployeeId = employee`). При `> 0` завершение
   * без `force` вернёт `409 SHIFT_HAS_ACTIVE_PASSPORTS`.
   */
  passportsInProgress: number;
  /**
   * У сотрудника идёт подкрой (`RecutSession.status = ACTIVE`) — время
   * доплаты продолжает тикать. Закрытие смены подкрой НЕ останавливает,
   * это только предупреждение мастеру.
   */
  hasActiveRecut: boolean;
}

export interface MasterActiveShiftsDto {
  /**
   * ISO-8601, серверное «сейчас» на момент выборки — от него UI считает
   * длительности смен (не от часов клиента, они могут врать).
   */
  now: string;
  /** Открытые смены, `startedAt` ASC — самые давние (забытые) сверху. */
  rows: MasterActiveShiftDto[];
}

/**
 * Тело принудительного завершения смены мастером. `force: true` —
 * подтверждённый повтор после `409 SHIFT_HAS_ACTIVE_PASSPORTS`
 * (у сотрудника паспорта в работе, UI показал инлайн-подтверждение).
 */
export const ForceCloseShiftSchema = z
  .object({
    force: z.boolean().optional().default(false),
  })
  .strict();
export type ForceCloseShiftDto = z.infer<typeof ForceCloseShiftSchema>;

/**
 * Результат `POST /active-shifts/:shiftId/close`. Смена, уже закрытая к
 * моменту запроса (сотрудник успел сам между GET и POST), — успех-noop
 * (`closed: false`), а не 404/409: список у мастера просто обновится.
 */
export interface MasterCloseShiftResultDto {
  /** `true` — смена закрыта этим запросом; `false` — уже была закрыта. */
  closed: boolean;
}
