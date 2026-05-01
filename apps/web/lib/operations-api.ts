/**
 * Серверные обёртки над `/api/operations` (см. `docs/api.md §15a`).
 * Используются из RSC `/admin/operations` и server actions
 * создания/редактирования операций.
 */
import type {
  CreateOperationDto,
  OperationDetailDto,
  OperationSummaryDto,
  UpdateOperationDto,
} from '@sewing/shared/operations';
import { apiFetch } from './api';

export function listOperations(): Promise<OperationSummaryDto[]> {
  return apiFetch<OperationSummaryDto[]>('/operations', {
    cache: 'no-store',
  });
}

export function getOperation(id: string): Promise<OperationDetailDto> {
  return apiFetch<OperationDetailDto>(
    `/operations/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createOperation(
  body: CreateOperationDto,
): Promise<OperationDetailDto> {
  return apiFetch<OperationDetailDto>('/operations', {
    method: 'POST',
    body,
  });
}

export function updateOperation(
  id: string,
  body: UpdateOperationDto,
): Promise<OperationDetailDto> {
  return apiFetch<OperationDetailDto>(
    `/operations/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}
