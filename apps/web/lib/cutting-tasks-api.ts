import 'server-only';
import type {
  CuttingTaskDetailDto,
  CuttingTaskSummaryDto,
  OrderReadyForReleaseDto,
  OrderReleaseStateDto,
  SaveCuttingTaskProgressDto,
} from '@sewing/shared/cutting-tasks';
import { apiFetch } from './api';

/**
 * Клиент для `/api/cutting-tasks` (кабинет раскройщика, роль `CUTTER`).
 * Используется RSC-страницами `/cutter` и server action-ами кабинета.
 */

export function listCuttingTasks(): Promise<CuttingTaskSummaryDto[]> {
  return apiFetch<CuttingTaskSummaryDto[]>('/cutting-tasks');
}

export function getCuttingTask(id: string): Promise<CuttingTaskDetailDto> {
  return apiFetch<CuttingTaskDetailDto>(
    `/cutting-tasks/${encodeURIComponent(id)}`,
  );
}

export function startCuttingTask(id: string): Promise<CuttingTaskDetailDto> {
  return apiFetch<CuttingTaskDetailDto>(
    `/cutting-tasks/${encodeURIComponent(id)}/start`,
    { method: 'POST' },
  );
}

export function saveCuttingTaskProgress(
  id: string,
  body: SaveCuttingTaskProgressDto,
): Promise<CuttingTaskDetailDto> {
  return apiFetch<CuttingTaskDetailDto>(
    `/cutting-tasks/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

export function completeCuttingTask(
  id: string,
  body: SaveCuttingTaskProgressDto,
): Promise<CuttingTaskDetailDto> {
  return apiFetch<CuttingTaskDetailDto>(
    `/cutting-tasks/${encodeURIComponent(id)}/complete`,
    { method: 'POST', body },
  );
}

/**
 * Доска помощника раскройщика `/work/cut-orders`: заказы с завершённым
 * раскроем, готовые к рулонному выпуску паспортов.
 */
export function listOrdersReadyForRelease(): Promise<OrderReadyForReleaseDto[]> {
  return apiFetch<OrderReadyForReleaseDto[]>('/cutting-tasks/ready-for-release');
}

/** Данные заказа для рулонного выпуска (размеры, рулоны, выпущенные пары). */
export function getOrderReleaseState(
  orderId: string,
): Promise<OrderReleaseStateDto> {
  return apiFetch<OrderReleaseStateDto>(
    `/cutting-tasks/by-order/${encodeURIComponent(orderId)}/release-state`,
  );
}
