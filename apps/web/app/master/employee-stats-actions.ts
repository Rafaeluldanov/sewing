'use server';

/**
 * Server actions вкладки «Сотрудники» в кабинете мастера: статистика
 * «кто сколько сделал» за выбранный период + режим «Активные»
 * (открытые смены прямо сейчас, принудительное завершение мастером).
 *
 * Контракт API — `apps/api/src/modules/master-employee-stats/*`.
 * Возвращают единый result-shape `{ ok: true, data } | { ok: false,
 * error }` — клиент обрабатывает одинаково, без throw (как у
 * `production-board-actions.ts`).
 */

import type {
  MasterActiveShiftsDto,
  MasterCloseShiftResultDto,
  MasterEmployeeDrillDto,
  MasterEmployeeStatsDrillQuery,
  MasterEmployeeStatsDto,
  MasterEmployeeStatsQuery,
} from '@sewing/shared';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  closeMasterActiveShift,
  getMasterActiveShifts,
  getMasterEmployeeStats,
  getMasterEmployeeStatsDrill,
} from '@/lib/master-employee-stats-api';

function explain(e: unknown): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
  }
  return 'Не удалось загрузить статистику';
}

export type LoadEmployeeStatsResult =
  | { ok: true; data: MasterEmployeeStatsDto }
  | { ok: false; error: string };

export async function loadEmployeeStatsAction(
  query: MasterEmployeeStatsQuery,
): Promise<LoadEmployeeStatsResult> {
  try {
    return { ok: true, data: await getMasterEmployeeStats(query) };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}

export type LoadEmployeeDrillResult =
  | { ok: true; data: MasterEmployeeDrillDto }
  | { ok: false; error: string };

export async function loadEmployeeStatsDrillAction(
  query: MasterEmployeeStatsDrillQuery,
): Promise<LoadEmployeeDrillResult> {
  try {
    return { ok: true, data: await getMasterEmployeeStatsDrill(query) };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}

export type LoadActiveShiftsResult =
  | { ok: true; data: MasterActiveShiftsDto }
  | { ok: false; error: string };

/** Режим «Активные»: открытые смены прямо сейчас. */
export async function loadActiveShiftsAction(): Promise<LoadActiveShiftsResult> {
  try {
    return { ok: true, data: await getMasterActiveShifts() };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}

export type CloseActiveShiftResult =
  | { ok: true; data: MasterCloseShiftResultDto }
  | {
      ok: false;
      error: string;
      /**
       * `409 SHIFT_HAS_ACTIVE_PASSPORTS`: у сотрудника паспорта в
       * работе — UI показывает инлайн-подтверждение в карточке и
       * повторяет с `force: true`. Количество паспортов ApiError не
       * несёт (тело бизнес-ошибки — только `{ message, code }`), UI
       * берёт `passportsInProgress` из карточки смены.
       */
      needsForce?: boolean;
    };

/**
 * Принудительное завершение смены мастером. Уже закрытая смена — успех
 * с `data.closed = false` (UI показывает «Смена уже закрыта» и
 * перезагружает список).
 */
export async function closeActiveShiftAction(
  shiftId: string,
  force: boolean,
): Promise<CloseActiveShiftResult> {
  try {
    return { ok: true, data: await closeMasterActiveShift(shiftId, { force }) };
  } catch (e) {
    if (
      e instanceof ApiRequestError &&
      e.code === 'SHIFT_HAS_ACTIVE_PASSPORTS'
    ) {
      return { ok: false, needsForce: true, error: errorText(e) };
    }
    return {
      ok: false,
      error: errorText(e, 'Не удалось завершить смену. Попробуйте ещё раз.'),
    };
  }
}
