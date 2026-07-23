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
  AcceptCalculatedWorkshopNeedsResultDto,
  CalculateWorkshopNeedsDto,
  CalculateWorkshopNeedsResultDto,
  CreateManualWorkshopNeedDto,
  ListWorkshopNeedsQuery,
  UpdateWorkshopNeedDto,
  WorkshopNeedDto,
  WorkshopNeedListItemDto,
  WorkshopNeedsArchiveResultDto,
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
      // Фича «Архив расчётов цеха»: скоуп по архивации заказа
      // (вкладки «Потребности» / «Архив»).
      orderArchive: query.orderArchive,
      search: query.search,
    },
  });
}

// ---------------------------------------------------------------------------
// Архив расчётов цеха: bulk archive / restore / purge
// ---------------------------------------------------------------------------

/** Отправить заказ(ы) в архив (скрыть из активного списка потребностей). */
export function archiveWorkshopNeedsOrders(
  orderIds: string[],
): Promise<WorkshopNeedsArchiveResultDto> {
  return apiFetch<WorkshopNeedsArchiveResultDto>('/workshop-needs/archive', {
    method: 'POST',
    body: { orderIds },
  });
}

/** Вернуть заказ(ы) из архива в активный список потребностей. */
export function restoreWorkshopNeedsOrders(
  orderIds: string[],
): Promise<WorkshopNeedsArchiveResultDto> {
  return apiFetch<WorkshopNeedsArchiveResultDto>('/workshop-needs/restore', {
    method: 'POST',
    body: { orderIds },
  });
}

/**
 * Безвозвратно стереть просчёт заказа(ов) — все `OrderCalculation` +
 * `WorkshopNeed`; сам заказ остаётся. Только из архива.
 */
export function purgeWorkshopNeedsOrders(
  orderIds: string[],
): Promise<WorkshopNeedsArchiveResultDto> {
  return apiFetch<WorkshopNeedsArchiveResultDto>('/workshop-needs/purge', {
    method: 'POST',
    body: { orderIds },
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
  opts?: {
    /**
     * Фича «Варианты просчёта»: скоуп по вариантам. Default backend —
     * `ACTIVE` (только активный вариант; так ходят производственно-
     * финансовые таблицы карточки — «Материалы», «Сводно», выдачи).
     * `ALL` — все варианты с меткой (вкладка «Потребности»).
     */
    calculationScope?: 'ACTIVE' | 'ALL';
  },
): Promise<WorkshopNeedListItemDto[]> {
  const query =
    opts?.calculationScope === 'ALL' ? '?calculationScope=ALL' : '';
  return apiFetch<WorkshopNeedListItemDto[]>(
    `/orders/${encodeURIComponent(orderId)}/workshop-needs${query}`,
    { cache: 'no-store' },
  );
}

/**
 * Экран «Согласование закупки»: bulk «Принять теорию для
 * непроверенных» — все `CALCULATED`-строки заказа получают
 * `purchaseQty := purchaseQty ?? calculatedQty` + `status = REVIEWED`.
 */
export function acceptCalculatedWorkshopNeeds(
  orderId: string,
): Promise<AcceptCalculatedWorkshopNeedsResultDto> {
  return apiFetch<AcceptCalculatedWorkshopNeedsResultDto>(
    `/orders/${encodeURIComponent(orderId)}/workshop-needs/accept-calculated`,
    { method: 'POST' },
  );
}

/**
 * Этап «Корректировка материалов после просчёта»: ручное добавление
 * строки потребности (непредвиденный расход материала). Разрешено в
 * `CALCULATION` / `CALCULATION_DONE` / `IN_PRODUCTION`.
 */
export function createManualWorkshopNeed(
  orderId: string,
  body: CreateManualWorkshopNeedDto,
): Promise<WorkshopNeedDto> {
  return apiFetch<WorkshopNeedDto>(
    `/orders/${encodeURIComponent(orderId)}/workshop-needs/manual`,
    { method: 'POST', body },
  );
}

/**
 * Удаление ручной строки потребности (только `isManual = true`).
 * Системные snapshot-строки удалять нельзя (409 `WORKSHOP_NEED_NOT_MANUAL`).
 */
export function deleteManualWorkshopNeed(
  orderId: string,
  needId: string,
): Promise<void> {
  return apiFetch<void>(
    `/orders/${encodeURIComponent(orderId)}/workshop-needs/${encodeURIComponent(needId)}`,
    { method: 'DELETE' },
  );
}
