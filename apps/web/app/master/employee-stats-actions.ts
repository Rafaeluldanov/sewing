'use server';

/**
 * Server actions вкладки «Сотрудники» в кабинете мастера (статистика
 * «кто сколько сделал» за выбранный период).
 *
 * Контракт API — `apps/api/src/modules/master-employee-stats/*`.
 * Возвращают единый result-shape `{ ok: true, data } | { ok: false,
 * error }` — клиент обрабатывает одинаково, без throw (как у
 * `production-board-actions.ts`).
 */

import type {
  MasterEmployeeDrillDto,
  MasterEmployeeStatsDrillQuery,
  MasterEmployeeStatsDto,
  MasterEmployeeStatsQuery,
} from '@sewing/shared';
import { ApiRequestError, errorText } from '@/lib/api';
import {
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
