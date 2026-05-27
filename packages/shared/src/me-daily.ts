/**
 * Контракты «Мой день» (`GET /api/me/daily`, `GET /api/me/history`).
 *
 * Лёгкий read-only виджет в кабинете сотрудника. Показывает на месте,
 * сколько штук выпустил за сегодня и сколько начислено (сделка + оклад),
 * а в раскрытой панели — историю за последние N дней.
 *
 * Источник истины контракта — `apps/api/src/modules/me/me.controller.ts`,
 * `apps/api/src/modules/me/me.service.ts`. UI — `apps/web/components/me/
 * daily-earnings-chip.tsx` + связанные.
 *
 * Политика «своих PENDING» здесь сознательно отличается от
 * `/api/earnings/summary`: сотрудник в личном кабинете ВИДИТ свои
 * pending-начисления (с явной пометкой «ждёт подтверждения»), потому
 * что в течение рабочего дня основная масса денег сидит именно в
 * PENDING_RELEASE до закрытия коробки упаковщиком. Чужие pending по-
 * прежнему недоступны (запрос строго по `viewer.employeeId`).
 */

import { z } from 'zod';
import type { CompensationType } from './employees';

export type { CompensationType };

// ---------------------------------------------------------------------------
// GET /api/me/daily — нет query, ответ — `MeDailyDto`
// ---------------------------------------------------------------------------

/**
 * Запись по одной операции в дневной разбивке сделки.
 *
 * `qty` — суммарное количество штук за день по этой операции
 * (склейка всех `OperationEntry` за сегодня по `(employeeId, operationId)`).
 * `amount` — итоговая сумма (approved + pending), `pendingAmount` — её
 * часть, которая ещё ждёт подтверждения упаковщика. UI рисует обе
 * цифры рядом и пометку «ждёт подтв.», если `pendingAmount > 0`.
 */
export interface MeDailyOperationDto {
  operationId: string;
  operationCode: string;
  operationName: string;
  qty: number;
  amount: number;
  approvedAmount: number;
  pendingAmount: number;
}

/**
 * Сделочная часть дневного итога. `null`, если у сотрудника
 * `compensationType = SALARY` или сегодня не было ни одной операции —
 * UI в этом случае не рисует блок сделки.
 */
export interface MeDailyPieceworkDto {
  byOperation: MeDailyOperationDto[];
  totalQty: number;
  /** approvedAmount + pendingAmount. */
  totalAmount: number;
  approvedAmount: number;
  pendingAmount: number;
}

/**
 * Окладная часть дневного итога. `null`, если у сотрудника
 * `compensationType = PIECEWORK` или у него `salaryPerShift = null` и
 * `SalaryEntry` за сегодня не было.
 */
export interface MeDailySalaryDto {
  /** Сумма из `SalaryEntry.amount` за сегодня (0, если записи нет). */
  amount: number;
  /** Есть ли сейчас активная `ShiftSession` (endedAt = null). */
  shiftOpen: boolean;
  /** ISO-метка начала смены, если она открыта. Иначе `null`. */
  shiftStartedAt: string | null;
  /** Ставка из `Employee.salaryPerShift` (для подсказки в UI). */
  salaryPerShift: number | null;
  /** `true`, если запись `SalaryEntry` за сегодня уже есть. */
  hasEntryToday: boolean;
}

/**
 * Ответ `GET /api/me/daily`.
 *
 * Если у сотрудника не задан `compensationType` (что в норме не должно
 * случаться, но защищаемся), оба блока — `null`, а `total = 0`. UI в
 * этом случае прячет чип целиком.
 */
export interface MeDailyDto {
  /** Дата по Europe/Moscow в формате YYYY-MM-DD. */
  date: string;
  compensationType: CompensationType | null;
  piecework: MeDailyPieceworkDto | null;
  salary: MeDailySalaryDto | null;
  /** Сумма к показу в чипе: piecework.totalAmount + salary.amount. */
  total: number;
}

// ---------------------------------------------------------------------------
// GET /api/me/history?days=30 — query + ответ
// ---------------------------------------------------------------------------

/**
 * Query для истории. На MVP единственный фильтр — горизонт в днях
 * (по умолчанию 30, максимум 90, чтобы не зачерпнуть всю историю
 * сотрудника одним запросом).
 */
export const MeHistoryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});
export type MeHistoryQuery = z.infer<typeof MeHistoryQuerySchema>;

/**
 * Один день истории. Поля `pieceworkAmount`/`salaryAmount` суммируются
 * для удобства UI; `total = pieceworkAmount + salaryAmount`.
 * `hasPending` подсвечивает дни, где часть сделки ещё ждёт упаковщика.
 */
export interface MeHistoryDayDto {
  /** Дата по Europe/Moscow в формате YYYY-MM-DD. */
  date: string;
  pieceworkQty: number;
  pieceworkAmount: number;
  pieceworkApprovedAmount: number;
  pieceworkPendingAmount: number;
  salaryAmount: number;
  total: number;
  hasPending: boolean;
}

/**
 * Ответ `GET /api/me/history`.
 *
 * `days` дублирует фактический горизонт (после применения умолчания и
 * клампа), `from`/`to` — границы по Europe/Moscow в формате YYYY-MM-DD.
 * `items` отсортированы по дате DESC (свежий день — сверху).
 */
export interface MeHistoryDto {
  days: number;
  from: string;
  to: string;
  items: MeHistoryDayDto[];
  totalPieceworkAmount: number;
  totalSalaryAmount: number;
  totalAmount: number;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const ME_DAILY_API_PATH = '/me/daily' as const;
export const ME_HISTORY_API_PATH = '/me/history' as const;

/**
 * Schema для парсинга строкового параметра `days` на клиенте, чтобы
 * не дублировать regex в UI. Возвращает уже зажатое значение.
 */
export function parseMeHistoryDays(raw: unknown): number {
  return MeHistoryQuerySchema.parse({ days: raw ?? 30 }).days;
}
