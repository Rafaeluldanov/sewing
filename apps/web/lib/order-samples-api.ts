/**
 * Серверные обёртки над `/api/orders/:id/samples` и
 * `/api/order-samples/*` (см.
 * `apps/api/src/modules/order-samples/*`,
 * `docs/api.md §«Order samples»`,
 * `docs/order-signal-sample-flow.md`).
 */

import type {
  ApproveOrderSampleDto,
  CancelOrderSampleDto,
  OrderSampleDto,
  OrderSampleListItemDto,
  RejectOrderSampleDto,
  StartOrderSampleDto,
} from '@sewing/shared/order-samples';
import { apiFetch } from './api';

export function listOrderSamples(
  orderId: string,
): Promise<OrderSampleListItemDto[]> {
  return apiFetch<OrderSampleListItemDto[]>(
    `/orders/${encodeURIComponent(orderId)}/samples`,
    { cache: 'no-store' },
  );
}

export function startOrderSample(
  orderId: string,
  body: StartOrderSampleDto,
): Promise<OrderSampleDto> {
  return apiFetch<OrderSampleDto>(
    `/orders/${encodeURIComponent(orderId)}/samples/start`,
    { method: 'POST', body },
  );
}

export function getOrderSample(id: string): Promise<OrderSampleDto> {
  return apiFetch<OrderSampleDto>(
    `/order-samples/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function approveOrderSample(
  id: string,
  body: ApproveOrderSampleDto = {},
): Promise<OrderSampleDto> {
  return apiFetch<OrderSampleDto>(
    `/order-samples/${encodeURIComponent(id)}/approve`,
    { method: 'POST', body },
  );
}

export function rejectOrderSample(
  id: string,
  body: RejectOrderSampleDto,
): Promise<OrderSampleDto> {
  return apiFetch<OrderSampleDto>(
    `/order-samples/${encodeURIComponent(id)}/reject`,
    { method: 'POST', body },
  );
}

export function cancelOrderSample(
  id: string,
  body: CancelOrderSampleDto = {},
): Promise<OrderSampleDto> {
  return apiFetch<OrderSampleDto>(
    `/order-samples/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body },
  );
}
