'use server';

/**
 * Server actions вкладки «Заказы» в кабинете мастера.
 *
 * Контракты: `apps/api/src/modules/master-orders/*` (список) и
 * `apps/api/src/modules/order-amendments/*` (состояние холста правки
 * маршрута). Возвращают единый result-shape `{ ok: true, data } |
 * { ok: false, error }` — клиент обрабатывает одинаково, без throw.
 *
 * Применение правки сюда НЕ дублируется: холст
 * (`RouteAmendmentTab`) сабмитит существующий
 * `applyRouteAmendmentAction` из `app/admin/orders/[id]/amendment-actions`
 * — одна ручка, один разбор ошибок, один журнал на обе роли.
 *
 * ВАЖНО: в `'use server'`-модуле можно экспортировать ТОЛЬКО
 * async-функции (`export const initial…` роняет рендер страницы целиком),
 * поэтому типы результатов объявлены через `export type`.
 */

import type { OperationAmendmentStateDto } from '@sewing/shared';
import type {
  MasterOrdersDto,
  MasterOrdersQuery,
} from '@sewing/shared/master-orders';
import { ApiRequestError, errorText } from '@/lib/api';
import { listMasterOrders } from '@/lib/master-orders-api';
import { getOperationAmendmentState } from '@/lib/amendments-api';

function explain(e: unknown, fallback: string): string {
  return e instanceof ApiRequestError ? errorText(e) : fallback;
}

export type LoadMasterOrdersResult =
  | { ok: true; data: MasterOrdersDto }
  | { ok: false; error: string };

export async function loadMasterOrdersAction(
  query: MasterOrdersQuery,
): Promise<LoadMasterOrdersResult> {
  try {
    return { ok: true, data: await listMasterOrders(query) };
  } catch (e) {
    return { ok: false, error: explain(e, 'Не удалось загрузить заказы') };
  }
}

export type LoadRouteStateResult =
  | { ok: true; data: OperationAmendmentStateDto }
  | { ok: false; error: string };

/**
 * Состояние холста правки маршрута: шаги снимка, фронт производства и
 * палитра операций справочника. GET открыт любой авторизованной роли —
 * мастер читает ровно то же состояние, что drawer заказа.
 */
export async function loadRouteAmendmentStateAction(
  orderId: string,
): Promise<LoadRouteStateResult> {
  try {
    return { ok: true, data: await getOperationAmendmentState(orderId) };
  } catch (e) {
    return { ok: false, error: explain(e, 'Не удалось загрузить маршрут') };
  }
}
