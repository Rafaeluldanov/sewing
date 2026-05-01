/**
 * Server-side обёртка над `GET /api/orders/:id/production-balance`
 * (см. `apps/api/src/modules/orders/orders.controller.ts::getProductionBalance`,
 * `OrderProductionBalanceService`).
 *
 * Computed endpoint, ничего не пишет в БД — отдаёт построчную
 * рекомендацию количества людей на операцию, узкое место и оценку
 * выпуска за смену. Используется блоком «Производственная цепочка»
 * на карточке заказа `/admin/orders/[id]`.
 */
import type {
  OrderProductionBalanceDto,
  OrderProductionBalanceQuery,
} from '@sewing/shared/order-production-balance';
import { apiFetch } from './api';

export function getOrderProductionBalance(
  orderId: string,
  query: OrderProductionBalanceQuery = {},
): Promise<OrderProductionBalanceDto> {
  return apiFetch<OrderProductionBalanceDto>(
    `/orders/${encodeURIComponent(orderId)}/production-balance`,
    {
      searchParams: {
        strategy: query.strategy,
        shiftSeconds: query.shiftSeconds,
        totalWorkers: query.totalWorkers,
        targetDurationSec: query.targetDurationSec,
      },
    },
  );
}
