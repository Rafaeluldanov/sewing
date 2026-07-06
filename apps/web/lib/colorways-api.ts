/**
 * Серверные обёртки над Nest API модуля «Расцветки заказа»
 * (`/api/orders/:id/colorways`). Контракт — `@sewing/shared/colorways`,
 * бэкенд — `apps/api/src/modules/order-colorways/*`.
 *
 * Все write-эндпоинты возвращают свежий полный `OrderColorwaysDto`,
 * чтобы UI обновлял состояние из одного источника.
 */

import type {
  OrderColorwaysDto,
  UpsertOrderColorwayDto,
} from '@sewing/shared';
import { apiFetch } from './api';

export function getOrderColorways(
  orderId: string,
): Promise<OrderColorwaysDto> {
  return apiFetch<OrderColorwaysDto>(
    `/orders/${encodeURIComponent(orderId)}/colorways`,
    { cache: 'no-store' },
  );
}

export function createOrderColorway(
  orderId: string,
  body: UpsertOrderColorwayDto,
): Promise<OrderColorwaysDto> {
  return apiFetch<OrderColorwaysDto>(
    `/orders/${encodeURIComponent(orderId)}/colorways`,
    { method: 'POST', body },
  );
}

export function updateOrderColorway(
  orderId: string,
  variantId: string,
  body: UpsertOrderColorwayDto,
): Promise<OrderColorwaysDto> {
  return apiFetch<OrderColorwaysDto>(
    `/orders/${encodeURIComponent(orderId)}/colorways/${encodeURIComponent(variantId)}`,
    { method: 'PATCH', body },
  );
}

export function deleteOrderColorway(
  orderId: string,
  variantId: string,
): Promise<OrderColorwaysDto> {
  return apiFetch<OrderColorwaysDto>(
    `/orders/${encodeURIComponent(orderId)}/colorways/${encodeURIComponent(variantId)}`,
    { method: 'DELETE' },
  );
}
