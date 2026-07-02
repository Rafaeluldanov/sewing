/**
 * Контракты «Тайм-трекер сотрудника» — вкладка на карточке сотрудника
 * (`apps/web/app/admin/employees/[id]/time-tracker`,
 * `apps/api/src/modules/time-tracking/*`). Read-only.
 *
 * Назначение: показать РАБОЧИЙ ДЕНЬ сотрудника во времени —
 *   1. когда начался сеанс (открытие смены сканом рабочего стола),
 *   2. какие операции он закрывал внутри сеанса,
 *   3. когда сеанс завершился (или что он идёт прямо сейчас).
 *
 * Модель данных (ничего нового не пишем, только агрегируем):
 *   - СЕАНС = `ShiftSession` (`startedAt`/`endedAt`, `equipment`,
 *     `operation`). Открытый сеанс (`endedAt = null`) считается до
 *     текущего момента (`now`) — часы «идут».
 *   - СОБЫТИЯ ВНУТРИ = `PassportEvent` сотрудника, попавшие во временное
 *     окно сеанса: `OPERATION_FINISHED` (закрытие операции, `qty =
 *     Passport.qtyGood`) и `ISSUED_TO_EMPLOYEE` (взят крой). Точных
 *     интервалов каждой операции в БД нет (реальный флоу —
 *     `ISSUED_TO_EMPLOYEE → OPERATION_FINISHED` без `SCAN`/`STARTED`,
 *     см. memory `project_no_operation_scan_events`), поэтому «загрузка»
 *     оценивается ПО ФАКТУ ЗАВЕРШЕНИЙ (шт/час), а не по хронометражу.
 *     Переключение операции внутри смены (`switchOperation`) события не
 *     пишет — но каждый `OPERATION_FINISHED` несёт свой `operationId`,
 *     поэтому таймлайн и так показывает, что реально закрывалось.
 *   - БРАК атрибутируется ИСПОЛНИТЕЛЮ операции ровно так же, как в
 *     «Статистике по сотрудникам» (`master-employee-stats`, finisher
 *     attribution) — сервис переиспользует ту же проверенную логику.
 *
 * Окно периода — по `YYYY-MM-DD` (UTC-день, как в
 * `master-employee-stats`; на реальных дневных сменах цеха UTC-день и
 * московский день совпадают, границы не пересекаются). Время самих
 * событий — абсолютные метки (ISO), UI форматирует их в `Europe/Moscow`.
 */

import { z } from 'zod';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Период тайм-трекера — произвольный диапазон дней `[from; to]`
 * включительно. `to` разворачивается в конец дня на бэке.
 */
export const TimeTrackingQuerySchema = z.object({
  from: z.string().regex(DAY_RE),
  to: z.string().regex(DAY_RE),
});
export type TimeTrackingQuery = z.infer<typeof TimeTrackingQuerySchema>;

// ---------------------------------------------------------------------------
// Событие таймлайна внутри сеанса
// ---------------------------------------------------------------------------

/**
 * Тип строки таймлайна. `SESSION_START`/`SESSION_END`/`IN_PROGRESS` —
 * синтетические маркеры границ сеанса (строятся из `ShiftSession`), не
 * события БД. Остальные — реальные `PassportEvent`.
 */
export type TimeTrackingEventType =
  | 'SESSION_START'
  | 'ISSUED_TO_EMPLOYEE'
  | 'OPERATION_FINISHED'
  | 'SESSION_END'
  | 'IN_PROGRESS';

export interface TimeTrackingEventDto {
  type: TimeTrackingEventType;
  /** Абсолютная метка (ISO). UI форматирует в `Europe/Moscow`. */
  at: string;
  operationCode: string | null;
  operationName: string | null;
  passportId: string | null;
  passportNumber: string | null;
  passportColor: string | null;
  passportSizeCode: string | null;
  /** Штук годного для `OPERATION_FINISHED`, иначе `null`. */
  qty: number | null;
}

// ---------------------------------------------------------------------------
// Сеанс
// ---------------------------------------------------------------------------

export interface TimeTrackingSessionDto {
  id: string;
  startedAt: string;
  /** `null` — сеанс ещё идёт. */
  endedAt: string | null;
  open: boolean;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  /** Текущая (последняя) операция сеанса — из `ShiftSession.operationId`. */
  operationId: string;
  operationCode: string;
  operationName: string;
  /** Длительность в минутах (для открытого — до `now`). */
  durationMinutes: number;
  /** Число `OPERATION_FINISHED` в окне сеанса. */
  operationsCount: number;
  /** Σ `qty` (штук годного) закрытых в сеансе операций. */
  qtyGood: number;
  /** Строки таймлайна по возрастанию времени, включая границы сеанса. */
  events: TimeTrackingEventDto[];
}

// ---------------------------------------------------------------------------
// День (для полосы «часы по дням» и сводки)
// ---------------------------------------------------------------------------

export interface TimeTrackingDayDto {
  /** `YYYY-MM-DD` (UTC-день). */
  day: string;
  minutes: number;
  sessionsCount: number;
  operationsCount: number;
  qtyGood: number;
  /** Брак, атрибутированный сотруднику за день (finisher attribution). */
  defects: number;
}

// ---------------------------------------------------------------------------
// Ответ
// ---------------------------------------------------------------------------

export interface TimeTrackingDto {
  employeeId: string;
  employeeName: string;
  /** `Employee.role` (основная роль, enum). */
  role: string;
  /** Полный набор ролей доступа (`Employee.roles`, enum). */
  roles: string[];
  /** Эхо запроса, `YYYY-MM-DD`. */
  from: string;
  to: string;
  // --- итоги за период ---
  totalMinutes: number;
  sessionsCount: number;
  /** Сколько сеансов сейчас открыто (обычно 0 или 1). */
  openSessionsCount: number;
  /** Σ закрытых операций во всех сеансах периода. */
  operationsCount: number;
  /** Σ штук годного. */
  qtyGood: number;
  /** Σ брака за период (finisher attribution, как в master-stats). */
  defects: number;
  /** Разбивка по дням, новые сверху. */
  byDay: TimeTrackingDayDto[];
  /** Сеансы периода, новые сверху; события внутри — по возрастанию. */
  sessions: TimeTrackingSessionDto[];
}

// ---------------------------------------------------------------------------
// Обзор ВСЕХ сотрудников (список-уровень вкладки «Сотрудники»)
// ---------------------------------------------------------------------------

/**
 * Строка обзорной таблицы «Тайм-трекер» по одному сотруднику за период.
 * Провал в строку → per-employee `TimeTrackingDto` (таймлайн сеансов).
 */
export interface TimeTrackingSummaryRowDto {
  employeeId: string;
  employeeName: string;
  /** `Employee.role` (основная роль, enum). */
  role: string;
  /** Есть ли открытый сеанс ПРЯМО СЕЙЧАС (вне зависимости от периода). */
  onShift: boolean;
  /** Станок/операция текущего открытого сеанса (если `onShift`). */
  currentEquipmentCode: string | null;
  currentOperationName: string | null;
  /** Отработано минут за период (открытый сеанс — до `now`). */
  totalMinutes: number;
  sessionsCount: number;
  /** Закрытых операций за период. */
  operationsCount: number;
  qtyGood: number;
  /** Брак за период (finisher attribution, как в master-stats). */
  defects: number;
  /** Выработка/час (по факту завершений), 0 если минут нет. */
  perHour: number;
  /** Последняя активность (последнее завершение/старт сеанса), ISO или null. */
  lastActivityAt: string | null;
}

export interface TimeTrackingSummaryDto {
  from: string;
  to: string;
  /** Все активные сотрудники (в т.ч. с нулевой активностью в периоде). */
  rows: TimeTrackingSummaryRowDto[];
}
