'use server';

/**
 * Server actions вкладки «Движение тиража» в кабинете мастера.
 *
 * Контракт API — `apps/api/src/modules/production-board/*`.
 * Возвращают единый result-shape `{ ok: true, data } | { ok: false,
 * error }` — клиент обрабатывает одинаково, без throw.
 */

import type {
  ProductionBoardDrillDto,
  ProductionBoardDrillQuery,
  ProductionBoardDto,
  RouteDivergencesDto,
} from '@sewing/shared';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  getProductionBoard,
  getProductionBoardDrill,
  getRouteDivergences,
} from '@/lib/production-board-api';

function explain(e: unknown): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
  }
  return 'Не удалось загрузить доску';
}

export type LoadBoardResult =
  | { ok: true; data: ProductionBoardDto }
  | { ok: false; error: string };

export async function loadProductionBoardAction(
  days: number,
): Promise<LoadBoardResult> {
  try {
    return { ok: true, data: await getProductionBoard(days) };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}

export type LoadDrillResult =
  | { ok: true; data: ProductionBoardDrillDto }
  | { ok: false; error: string };

export async function loadProductionBoardDrillAction(
  query: ProductionBoardDrillQuery,
): Promise<LoadDrillResult> {
  try {
    return { ok: true, data: await getProductionBoardDrill(query) };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}

export type LoadDivergencesResult =
  | { ok: true; data: RouteDivergencesDto }
  | { ok: false; error: string };

/**
 * Вкладка «Расхождения». Отдельное действие, а не часть доски: мастер
 * открывает её утром на пять минут, и она не должна ждать тяжёлый
 * запрос доски за 30 дней.
 */
export async function loadRouteDivergencesAction(): Promise<LoadDivergencesResult> {
  try {
    return { ok: true, data: await getRouteDivergences() };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}
