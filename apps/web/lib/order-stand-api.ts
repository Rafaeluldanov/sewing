/**
 * «Схема стенда» по заказу — `GET /api/orders/:id/stand`
 * (см. `@sewing/shared/order-stand`, `docs/api.md §11a`).
 *
 * Серверный fetch для первого рендера страницы
 * `/admin/orders/[id]/stand`; дальше клиентская доска
 * (`order-stand-board.tsx`) опрашивает тот же путь сама — через
 * `getApiBaseUrl()` + `credentials: 'include'`, как `/shopfloor/display`.
 */
import type { OrderStandDto } from '@sewing/shared/order-stand';
import { apiFetch } from './api';

export function getOrderStand(orderId: string): Promise<OrderStandDto> {
  return apiFetch<OrderStandDto>(`/orders/${encodeURIComponent(orderId)}/stand`);
}
