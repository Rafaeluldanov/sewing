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
} from '@sewing/shared';
import { ApiRequestError } from '@/lib/api';
import {
  getProductionBoard,
  getProductionBoardDrill,
} from '@/lib/production-board-api';

function explain(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
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
