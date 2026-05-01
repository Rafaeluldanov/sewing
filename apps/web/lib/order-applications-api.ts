/**
 * Серверная обёртка над `/api/orders/:id/applications` (см.
 * `apps/api/src/modules/order-applications/*`,
 * `packages/shared/src/order-applications.ts`).
 *
 * Используется RSC-блоком «Нанесение» в карточке заказа
 * (`apps/web/app/admin/orders/[id]/page.tsx`) и server action
 * сохранения формы. Контракт — `OrderApplicationDto[]` /
 * `ReplaceOrderApplicationsDto` из shared-пакета.
 */
import type {
  OrderApplicationDto,
  ReplaceOrderApplicationsDto,
} from '@sewing/shared/order-applications';
import { apiFetch } from './api';

/**
 * Получить список нанесений по заказу.
 *
 * `cache: 'no-store'` — каждое чтение видит актуальное состояние,
 * без кэша между разными состояниями редактирования.
 */
export function getOrderApplications(
  orderId: string,
): Promise<OrderApplicationDto[]> {
  return apiFetch<OrderApplicationDto[]>(
    `/orders/${encodeURIComponent(orderId)}/applications`,
    { cache: 'no-store' },
  );
}

/**
 * Полная замена списка нанесений по заказу. Backend в одной
 * транзакции удаляет существующие и создаёт переданные. Менять
 * можно только в `DRAFT` (см.
 * `OrderApplicationsService.replaceForOrder`); на других статусах
 * приходит 409 `ORDER_APPLICATION_ORDER_LOCKED`.
 */
export function replaceOrderApplications(
  orderId: string,
  input: ReplaceOrderApplicationsDto,
): Promise<OrderApplicationDto[]> {
  return apiFetch<OrderApplicationDto[]>(
    `/orders/${encodeURIComponent(orderId)}/applications`,
    {
      method: 'PUT',
      body: input,
      cache: 'no-store',
    },
  );
}
