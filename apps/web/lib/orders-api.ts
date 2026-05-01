/**
 * Типизированные обёртки поверх `apiFetch` под эндпоинты заказов.
 *
 * Все функции — серверные. Page-компоненты вызывают их из RSC;
 * формы пишут server actions, которые уже внутри дёргают эти функции.
 */

import type {
  CreateOrderDto,
  ListOrdersQuery,
  OrderDetailDto,
  OrderListItemDto,
  OrderStatus,
  Paginated,
  ProductDto,
  SizeDto,
  UpdateOrderDto,
} from '@sewing/shared/orders';
import { apiFetch } from './api';

export function listOrders(query: Partial<ListOrdersQuery> = {}): Promise<
  Paginated<OrderListItemDto>
> {
  return apiFetch<Paginated<OrderListItemDto>>('/orders', {
    searchParams: {
      search: query.search,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
    },
  });
}

export function getOrder(id: string): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(`/orders/${encodeURIComponent(id)}`);
}

export function createOrder(body: CreateOrderDto): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>('/orders', {
    method: 'POST',
    body,
  });
}

export function updateOrder(
  id: string,
  body: UpdateOrderDto,
): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(`/orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

export function startOrder(id: string): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(`/orders/${encodeURIComponent(id)}/start`, {
    method: 'POST',
  });
}

export function completeOrder(id: string): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(`/orders/${encodeURIComponent(id)}/complete`, {
    method: 'POST',
  });
}

export function cancelOrder(id: string): Promise<OrderDetailDto> {
  return apiFetch<OrderDetailDto>(`/orders/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
}

export function listSizes(): Promise<SizeDto[]> {
  return apiFetch<SizeDto[]>('/sizes', {
    next: { revalidate: 60, tags: ['sizes'] },
  });
}

export function listProducts(): Promise<ProductDto[]> {
  return apiFetch<ProductDto[]>('/products', {
    next: { revalidate: 60, tags: ['products'] },
  });
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: 'Черновик',
  IN_PRODUCTION: 'В производстве',
  DONE: 'Завершён',
  CANCELLED: 'Отменён',
};
