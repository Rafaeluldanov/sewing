/**
 * Серверные обёртки над `/api/purchase-orders/*` и
 * `/api/orders/:id/purchase-orders` (см. модуль
 * `apps/api/src/modules/purchase-orders/*`).
 *
 * Используется из RSC (`/admin/purchase-orders/*`, блок «Заказы
 * поставщикам» в карточке заказа клиента) и из server actions
 * (создание/правка PO, переходы статусов). Контракты — те же
 * Zod-схемы из `@sewing/shared/purchase-orders`, что валидирует
 * backend.
 */
import type {
  ConfirmPurchaseOrderDto,
  CreatePurchaseOrderFromNeedsDto,
  ListPurchaseOrdersQuery,
  PurchaseOrderDetailDto,
  PurchaseOrderListItemDto,
  UpdatePurchaseOrderDto,
  UpdatePurchaseOrderLineDto,
} from '@sewing/shared/purchase-orders';
import { apiFetch } from './api';

export function listPurchaseOrders(
  query: ListPurchaseOrdersQuery = {},
): Promise<PurchaseOrderListItemDto[]> {
  return apiFetch<PurchaseOrderListItemDto[]>('/purchase-orders', {
    cache: 'no-store',
    searchParams: {
      search: query.search,
      status: query.status,
      supplierId: query.supplierId,
      customerOrderId: query.customerOrderId,
    },
  });
}

export function getPurchaseOrder(id: string): Promise<PurchaseOrderDetailDto> {
  return apiFetch<PurchaseOrderDetailDto>(
    `/purchase-orders/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createPurchaseOrderFromNeeds(
  body: CreatePurchaseOrderFromNeedsDto,
): Promise<PurchaseOrderDetailDto> {
  return apiFetch<PurchaseOrderDetailDto>('/purchase-orders/from-needs', {
    method: 'POST',
    body,
  });
}

export function updatePurchaseOrder(
  id: string,
  body: UpdatePurchaseOrderDto,
): Promise<PurchaseOrderDetailDto> {
  return apiFetch<PurchaseOrderDetailDto>(
    `/purchase-orders/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

export function updatePurchaseOrderLine(
  orderId: string,
  lineId: string,
  body: UpdatePurchaseOrderLineDto,
): Promise<PurchaseOrderDetailDto> {
  return apiFetch<PurchaseOrderDetailDto>(
    `/purchase-orders/${encodeURIComponent(orderId)}/lines/${encodeURIComponent(lineId)}`,
    { method: 'PATCH', body },
  );
}

export function sendPurchaseOrder(id: string): Promise<PurchaseOrderDetailDto> {
  return apiFetch<PurchaseOrderDetailDto>(
    `/purchase-orders/${encodeURIComponent(id)}/send`,
    { method: 'POST' },
  );
}

export function confirmPurchaseOrder(
  id: string,
  body: ConfirmPurchaseOrderDto = {},
): Promise<PurchaseOrderDetailDto> {
  return apiFetch<PurchaseOrderDetailDto>(
    `/purchase-orders/${encodeURIComponent(id)}/confirm`,
    { method: 'POST', body },
  );
}

export function reopenPurchaseOrder(
  id: string,
): Promise<PurchaseOrderDetailDto> {
  return apiFetch<PurchaseOrderDetailDto>(
    `/purchase-orders/${encodeURIComponent(id)}/reopen`,
    { method: 'POST' },
  );
}

export function cancelPurchaseOrder(
  id: string,
): Promise<PurchaseOrderDetailDto> {
  return apiFetch<PurchaseOrderDetailDto>(
    `/purchase-orders/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' },
  );
}

export function getOrderPurchaseOrders(
  customerOrderId: string,
): Promise<PurchaseOrderListItemDto[]> {
  return apiFetch<PurchaseOrderListItemDto[]>(
    `/orders/${encodeURIComponent(customerOrderId)}/purchase-orders`,
    { cache: 'no-store' },
  );
}
