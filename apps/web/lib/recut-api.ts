import 'server-only';
import type {
  RecutOrderSearchItemDto,
  RecutSessionDto,
} from '@sewing/shared/recut';
import { apiFetch } from './api';

/**
 * Клиент для `/api/recut` (фича «Подкрой», роль `CUTTER`). Используется
 * RSC-страницей `/cutter` и server action-ами кабинета
 * (`apps/web/app/cutter/actions.ts`).
 */

/** Активный подкрой текущего раскройщика (или `null`). */
export function getActiveRecut(): Promise<RecutSessionDto | null> {
  return apiFetch<RecutSessionDto | null>('/recut/active');
}

/** Поиск заказа по номеру (любой статус, вкл. завершённые). */
export function searchRecutOrders(
  q: string,
): Promise<RecutOrderSearchItemDto[]> {
  return apiFetch<RecutOrderSearchItemDto[]>('/recut/orders', {
    searchParams: { q },
  });
}

export function startRecut(orderId: string): Promise<RecutSessionDto> {
  return apiFetch<RecutSessionDto>('/recut/start', {
    method: 'POST',
    body: { orderId },
  });
}

export function completeRecut(id: string): Promise<RecutSessionDto> {
  return apiFetch<RecutSessionDto>(
    `/recut/${encodeURIComponent(id)}/complete`,
    { method: 'POST' },
  );
}

export function cancelRecut(id: string): Promise<RecutSessionDto> {
  return apiFetch<RecutSessionDto>(
    `/recut/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' },
  );
}
