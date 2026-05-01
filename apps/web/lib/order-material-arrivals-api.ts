/**
 * Серверные обёртки над `/api/orders/:orderId/material-arrived` и
 * `/api/orders/:orderId/material-arrival-overrides/...` (см. модуль
 * `apps/api/src/modules/order-material-arrivals/*`,
 * `prisma/schema.prisma::OrderMaterialArrivalOverride`).
 *
 * Используются server actions карточки заказа
 * (`apps/web/app/admin/orders/[id]/material-arrivals-actions.ts`)
 * и серверным компонентом «Готовность к крою»
 * (`apps/web/components/orders/cut-readiness-card.tsx`).
 *
 * Контракты — `OrderMaterialArrivalOverrideDto` /
 * `CreateOrderMaterialArrivalOverrideDto` /
 * `RevokeOrderMaterialArrivalOverrideDto` из
 * `@sewing/shared/order-material-arrivals`. Все запросы
 * `cache: 'no-store'`, чтобы UI всегда видел актуальное
 * состояние overrides.
 */
import type {
  CreateOrderMaterialArrivalOverrideDto,
  OrderMaterialArrivalOverrideDto,
  RevokeOrderMaterialArrivalOverrideDto,
} from '@sewing/shared/order-material-arrivals';
import { apiFetch } from './api';

export function listOrderMaterialArrivalOverrides(
  orderId: string,
): Promise<OrderMaterialArrivalOverrideDto[]> {
  return apiFetch<OrderMaterialArrivalOverrideDto[]>(
    `/orders/${encodeURIComponent(orderId)}/material-arrival-overrides`,
    { cache: 'no-store' },
  );
}

export function markOrderMaterialArrived(
  orderId: string,
  dto: CreateOrderMaterialArrivalOverrideDto,
): Promise<OrderMaterialArrivalOverrideDto[]> {
  return apiFetch<OrderMaterialArrivalOverrideDto[]>(
    `/orders/${encodeURIComponent(orderId)}/material-arrived`,
    { method: 'POST', body: dto, cache: 'no-store' },
  );
}

export function revokeOrderMaterialArrivalOverride(
  orderId: string,
  overrideId: string,
  dto: RevokeOrderMaterialArrivalOverrideDto,
): Promise<OrderMaterialArrivalOverrideDto> {
  return apiFetch<OrderMaterialArrivalOverrideDto>(
    `/orders/${encodeURIComponent(orderId)}/material-arrival-overrides/${encodeURIComponent(overrideId)}/revoke`,
    { method: 'POST', body: dto, cache: 'no-store' },
  );
}
