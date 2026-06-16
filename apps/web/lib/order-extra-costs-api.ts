/**
 * Серверные обёртки над `/api/orders/:orderId/extra-costs/*` (этап
 * «Корректировка материалов после просчёта», см.
 * `apps/api/src/modules/order-extra-costs/*`).
 *
 * Контракты — Zod-схемы из `@sewing/shared/order-extra-costs`.
 */
import type {
  CreateOrderExtraCostDto,
  OrderExtraCostDto,
  UpdateOrderExtraCostDto,
} from '@sewing/shared/order-extra-costs';
import { apiFetch } from './api';

export function listOrderExtraCosts(
  orderId: string,
): Promise<OrderExtraCostDto[]> {
  return apiFetch<OrderExtraCostDto[]>(
    `/orders/${encodeURIComponent(orderId)}/extra-costs`,
    { cache: 'no-store' },
  );
}

export function createOrderExtraCost(
  orderId: string,
  body: CreateOrderExtraCostDto,
): Promise<OrderExtraCostDto> {
  return apiFetch<OrderExtraCostDto>(
    `/orders/${encodeURIComponent(orderId)}/extra-costs`,
    { method: 'POST', body },
  );
}

export function updateOrderExtraCost(
  orderId: string,
  costId: string,
  body: UpdateOrderExtraCostDto,
): Promise<OrderExtraCostDto> {
  return apiFetch<OrderExtraCostDto>(
    `/orders/${encodeURIComponent(orderId)}/extra-costs/${encodeURIComponent(costId)}`,
    { method: 'PATCH', body },
  );
}

export function deleteOrderExtraCost(
  orderId: string,
  costId: string,
): Promise<void> {
  return apiFetch<void>(
    `/orders/${encodeURIComponent(orderId)}/extra-costs/${encodeURIComponent(costId)}`,
    { method: 'DELETE' },
  );
}
