/**
 * Серверные обёртки над `/api/workshop-needs/*` и
 * `/api/orders/:id/workshop-needs/*` (см. модуль
 * `apps/api/src/modules/workshop-needs/*`).
 *
 * Используется из RSC (`/admin/workshop-needs/*`, блок «Потребность
 * цеха» в карточке заказа) и из server actions редактирования.
 * Контракты — те же Zod-схемы из `@sewing/shared/workshop-needs`,
 * что валидирует backend.
 */
import type {
  CalculateWorkshopNeedsDto,
  CalculateWorkshopNeedsResultDto,
  ListWorkshopNeedsQuery,
  UpdateWorkshopNeedDto,
  WorkshopNeedDto,
  WorkshopNeedListItemDto,
} from '@sewing/shared/workshop-needs';
import { apiFetch } from './api';

export function listWorkshopNeeds(
  query: ListWorkshopNeedsQuery = {},
): Promise<WorkshopNeedListItemDto[]> {
  return apiFetch<WorkshopNeedListItemDto[]>('/workshop-needs', {
    cache: 'no-store',
    searchParams: {
      orderId: query.orderId,
      // `status` — технический фильтр по `WorkshopNeed.status`. Он
      // больше не используется UI страницы `/admin/workshop-needs`
      // (фильтр «Статус расчёта» работает по `Order.status` через
      // `orderCalculationStatus`), но API его поддерживает — оставляем
      // для других возможных консьюмеров.
      status: query.status,
      orderCalculationStatus: query.orderCalculationStatus,
      search: query.search,
    },
  });
}

export function getWorkshopNeed(id: string): Promise<WorkshopNeedDto> {
  return apiFetch<WorkshopNeedDto>(
    `/workshop-needs/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function updateWorkshopNeed(
  id: string,
  body: UpdateWorkshopNeedDto,
): Promise<WorkshopNeedDto> {
  return apiFetch<WorkshopNeedDto>(
    `/workshop-needs/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body,
    },
  );
}

export function cancelWorkshopNeed(id: string): Promise<WorkshopNeedDto> {
  return apiFetch<WorkshopNeedDto>(
    `/workshop-needs/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' },
  );
}

export function calculateOrderWorkshopNeeds(
  orderId: string,
  options: CalculateWorkshopNeedsDto = { force: false },
): Promise<CalculateWorkshopNeedsResultDto> {
  return apiFetch<CalculateWorkshopNeedsResultDto>(
    `/orders/${encodeURIComponent(orderId)}/workshop-needs/calculate`,
    {
      method: 'POST',
      body: options,
    },
  );
}

export function getOrderWorkshopNeeds(
  orderId: string,
): Promise<WorkshopNeedListItemDto[]> {
  return apiFetch<WorkshopNeedListItemDto[]>(
    `/orders/${encodeURIComponent(orderId)}/workshop-needs`,
    { cache: 'no-store' },
  );
}
