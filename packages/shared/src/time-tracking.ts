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
 *   - ЧАСЫ сеанса = сумма его отрезков `ShiftSegment`, обрезанных
 *     границами периода (общее ядро `shifts/shift-time.ts`, то же, что
 *     у табеля мастера). Поэтому смена, начавшаяся до периода, не
 *     пропадает, ушедшая за его конец не засчитывается целиком, а
 *     ночная смена делится между сутками, а не падает в день начала.
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
 * Окно периода — по `YYYY-MM-DD` в МОСКОВСКИХ сутках (как в
 * `master-employee-stats`: цех живёт по Москве, и работа 00:00–03:00
 * МСК должна оставаться в своём дне, а не уезжать в предыдущий).
 * Время самих событий — абсолютные метки (ISO), UI форматирует их в
 * `Europe/Moscow`.
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
  /**
   * Отрезки сеанса по возрастанию времени. Пустой список — смена без
   * `ShiftSegment` (заведена до их появления): UI откатывается на
   * плоский `events`.
   */
  segments: TimeTrackingSegmentDto[];
}

/**
 * Отрезок сеанса — участок работы с НЕИЗМЕННОЙ операцией
 * (`ShiftSegment`). Внутри одной смены их столько, сколько раз
 * сотрудник переключал операцию на станке.
 *
 * До появления отрезков смена показывалась одной строкой с ПОСЛЕДНЕЙ
 * операцией, и восьмичасовой сеанс с тремя переключениями выглядел как
 * восемь часов последней работы.
 *
 * `events` — те же строки таймлайна, что и раньше, только разложенные
 * по своему отрезку: сразу видно, к какой операции относится закрытый
 * паспорт. У смен, заведённых до `ShiftSegment` и не попавших в
 * бэкфилл, список отрезков пуст — UI в этом случае рисует плоский
 * таймлайн сеанса (`TimeTrackingSessionDto.events`), как прежде.
 */
export interface TimeTrackingSegmentDto {
  id: string;
  startedAt: string;
  /** `null` — отрезок идёт прямо сейчас. */
  endedAt: string | null;
  minutes: number;
  operationId: string;
  operationCode: string;
  operationName: string;
  /** `OperationCategory` — по ней UI красит участок. */
  category: string;
  equipmentId: string;
  equipmentName: string;
  equipmentDisplayNumber: string | null;
  /** Закрытых операций внутри отрезка. */
  operationsCount: number;
  /** Σ штук годного внутри отрезка. */
  qtyGood: number;
  /**
   * Выполнение нормы, %: план (`Operation.timeNormSec` × штуки) к факту
   * (минуты отрезка). `null`, если нормы нет, она поразмерная, либо
   * нет штук/времени.
   */
  normPercent: number | null;
  open: boolean;
  events: TimeTrackingEventDto[];
}

/** Строка «Где был»: участок (категория + рабочее место) за период. */
export interface TimeTrackingPlaceDto {
  /** `category:equipmentId` — ключ для React. */
  key: string;
  category: string;
  equipmentName: string;
  equipmentDisplayNumber: string | null;
  minutes: number;
  /** Доля от времени в смене, 0–100. */
  share: number;
  /** Сколько разных операций сотрудник делал на этом месте. */
  operations: number;
}

// ---------------------------------------------------------------------------
// День (для полосы «часы по дням» и сводки)
// ---------------------------------------------------------------------------

export interface TimeTrackingDayDto {
  /** `YYYY-MM-DD` (московские сутки). */
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
  /**
   * Брак, который сотрудник ЗАФИКСИРОВАЛ сам (работа ОТК). Это НЕ
   * `defects`: там брак, найденный на его операциях. Путать нельзя.
   */
  defectsFound: number;
  /**
   * «На работе»: от начала первого отрезка до конца последнего, минут.
   * Не сумма отрезков — включает паузы между сеансами.
   */
  presenceMinutes: number;
  /** `presenceMinutes − totalMinutes` («вне смены»). */
  idleMinutes: number;
  /** Пауз между отрезками (зазор от минуты). */
  breaks: number;
  /** Загрузка, %: `totalMinutes / presenceMinutes`. */
  utilization: number | null;
  /**
   * Выполнение нормы за период, %: Σ(норма × штуки) к Σ(время операций
   * с заданной нормой). Операции без нормы в расчёт не входят вовсе —
   * иначе процент занижался бы там, где норма просто не заведена.
   */
  normPercent: number | null;
  /** «Где был» — участки периода, по времени убыв. */
  places: TimeTrackingPlaceDto[];
  /** Разбивка по дням, новые сверху. */
  byDay: TimeTrackingDayDto[];
  /** Сеансы периода, новые сверху; события внутри — по возрастанию. */
  sessions: TimeTrackingSessionDto[];
}

// ---------------------------------------------------------------------------
// Обзор ВСЕХ сотрудников (список-уровень вкладки «Сотрудники»)
// ---------------------------------------------------------------------------

/**
 * Кусок мини-ленты дня в строке обзора: раскраска участков без
 * подписей. `startMinute` — минут от начала московских суток (0–1440),
 * чтобы UI не парсил даты ради процента ширины.
 */
export interface TimeTrackingRibbonPartDto {
  startMinute: number;
  minutes: number;
  /** `OperationCategory` — цвет участка. */
  category: string;
}

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
  /**
   * «На работе» за период, минут (с паузами между сеансами). Вместе с
   * `totalMinutes` даёт ответ на вопрос, которого таблица не давала:
   * человек все эти часы работал или половину простоял.
   */
  presenceMinutes: number;
  /** Загрузка, %: `totalMinutes / presenceMinutes`. */
  utilization: number | null;
  /**
   * Открытая смена тянется с прошлых суток — забыл закрыться. У мастера
   * на это отдельная плашка; здесь признак нужен, чтобы не принимать
   * «22:40 отработано» за настоящую переработку.
   */
  staleShift: boolean;
  /**
   * Мини-лента дня: отрезки на общей для таблицы шкале. Заполняется
   * ТОЛЬКО когда период = одни сутки (`from === to`) — на неделе лента
   * превратилась бы в кашу.
   */
  ribbon: TimeTrackingRibbonPartDto[];
  /** Последняя активность (последнее завершение/старт сеанса), ISO или null. */
  lastActivityAt: string | null;
}

export interface TimeTrackingSummaryDto {
  from: string;
  to: string;
  /** Все активные сотрудники (в т.ч. с нулевой активностью в периоде). */
  rows: TimeTrackingSummaryRowDto[];
}
