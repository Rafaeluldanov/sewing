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
 * Замена списка нанесений по заказу. Backend в одной транзакции
 * сверяет присланное с сохранённым ПО `id`: строка с известным id
 * обновляется на месте, без id — создаётся, отсутствующая в теле —
 * удаляется. Пересоздание с новым id рвало бы снимок потребности
 * (`WorkshopNeed.sourceId`) вместе с ценой и поставщиком, поэтому UI
 * обязан слать `id` для строк, пришедших с сервера (см. `serverId` в
 * `components/orders/order-applications-editor.tsx`).
 *
 * Менять можно на любой стадии заказа, кроме `CANCELLED` (см.
 * `isOrderApplicationsEditable`,
 * `OrderApplicationsService.replaceForOrder`); у отменённого приходит
 * 409 `ORDER_APPLICATION_ORDER_LOCKED`.
 *
 * Потребность цеха backend догоняет сам: на `CALCULATION` — полным
 * пересчётом, после завершения расчёта (`isOrderApplicationsLateEdit`)
 * — точечной синхронизацией строк нанесений. Там же жёстче удаление:
 * нанесение, по которому уже пошла закупка, отбивается 409
 * `ORDER_APPLICATION_HAS_PURCHASE`.
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
