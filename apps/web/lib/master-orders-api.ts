/**
 * Серверная обёртка над `GET /api/master/orders` — вкладка «Заказы»
 * кабинета мастера (`apps/api/src/modules/master-orders/*`, контракт
 * `@sewing/shared/master-orders`).
 *
 * Рассчитана на использование из RSC / server actions.
 */

import type {
  MasterOrdersDto,
  MasterOrdersQuery,
} from '@sewing/shared/master-orders';
import { apiFetch } from './api';

export function listMasterOrders(
  query: MasterOrdersQuery,
): Promise<MasterOrdersDto> {
  const params = new URLSearchParams({ tab: query.tab });
  const search = query.search?.trim();
  if (search) params.set('search', search);
  return apiFetch<MasterOrdersDto>(`/master/orders?${params.toString()}`, {
    cache: 'no-store',
  });
}
