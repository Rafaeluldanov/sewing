'use server';

/**
 * Server actions вкладки «Движение тиража» в кабинете мастера.
 *
 * Контракт API — `apps/api/src/modules/production-board/*`.
 * Возвращают единый result-shape `{ ok: true, data } | { ok: false,
 * error }` — клиент обрабатывает одинаково, без throw.
 */

import type {
  CreateRouteWorkPermitDto,
  RouteWorkPermitDto,
  ProductionBoardDrillDto,
  ProductionBoardDrillQuery,
  ProductionBoardDto,
  RouteDebtsDto,
  RouteDivergencesDto,
} from '@sewing/shared';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  getProductionBoard,
  getProductionBoardDrill,
  getRouteDebts,
  getRouteDivergences,
} from '@/lib/production-board-api';
import {
  createRouteWorkPermit,
  listRouteWorkPermits,
  revokeRouteWorkPermit,
} from '@/lib/master-actions-api';

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

export type LoadDebtsResult =
  | { ok: true; data: RouteDebtsDto }
  | { ok: false; error: string };

/**
 * Секция «Незакрытая работа» вкладки «Расхождения»: шаги маршрута,
 * которые паспорт проехал, не закрыв. Грузится параллельно с
 * расхождениями и независимо от них.
 */
export async function loadRouteDebtsAction(): Promise<LoadDebtsResult> {
  try {
    return { ok: true, data: await getRouteDebts() };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}

export type PermitResult =
  | { ok: true; data: RouteWorkPermitDto }
  | { ok: false; error: string };

/**
 * Выдать наряд-допуск прямо из строки «Расхождений». Строка — это ровно
 * пара «заказ × операция», то есть готовый допуск; мастеру остаётся
 * указать, какой шаг маршрута эта работа закрывает.
 */
export async function issueRouteWorkPermitAction(
  dto: CreateRouteWorkPermitDto,
): Promise<PermitResult> {
  try {
    return { ok: true, data: await createRouteWorkPermit(dto) };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}

export type PermitListResult =
  | { ok: true; items: RouteWorkPermitDto[] }
  | { ok: false; error: string };

export async function loadRouteWorkPermitsAction(): Promise<PermitListResult> {
  try {
    return { ok: true, items: await listRouteWorkPermits() };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}

export async function revokeRouteWorkPermitAction(
  id: string,
  reason: string,
): Promise<PermitResult> {
  try {
    return { ok: true, data: await revokeRouteWorkPermit(id, { reason }) };
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
}
