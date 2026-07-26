/**
 * Серверные обёртки над `/api/operations` (см. `docs/api.md §15a`).
 * Используются из RSC `/admin/operations` и server actions
 * создания/редактирования операций.
 */
import type {
  CreateOperationDto,
  OperationBlockersResponse,
  OperationDetailDto,
  OperationSummaryDto,
  UpdateOperationDto,
  UpdateOperationEquipmentDto,
} from '@sewing/shared/operations';
import { apiFetch } from './api';

export function listOperations(
  search?: string,
): Promise<OperationSummaryDto[]> {
  const q = search?.trim();
  const path = q ? `/operations?search=${encodeURIComponent(q)}` : '/operations';
  return apiFetch<OperationSummaryDto[]>(path, {
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

/**
 * Привязка операции к набору оборудования со стороны операции
 * (`PATCH /api/operations/:id/equipment`). Replace-all: `equipmentIds`
 * становятся единственными активными привязками операции. Зеркало
 * `updateEquipmentOperations` из `equipment-api.ts`.
 */
export function updateOperationEquipment(
  id: string,
  body: UpdateOperationEquipmentDto,
): Promise<OperationDetailDto> {
  return apiFetch<OperationDetailDto>(
    `/operations/${encodeURIComponent(id)}/equipment`,
    { method: 'PATCH', body },
  );
}

/**
 * Превью «можно ли физически удалить операцию» (см.
 * `OperationsService.getBlockers`). Используется server action перед
 * показом кнопки «Удалить», чтобы не давать жать DELETE впустую.
 */
export function getOperationBlockers(
  id: string,
): Promise<OperationBlockersResponse> {
  return apiFetch<OperationBlockersResponse>(
    `/operations/${encodeURIComponent(id)}/blockers`,
    { cache: 'no-store' },
  );
}

/**
 * Физическое удаление операции (`DELETE /api/operations/:id`,
 * только `ADMIN`). 409 `OPERATION_IN_USE`, если на операцию есть
 * ссылки — тогда остаётся мягкое удаление (`updateOperation` с
 * `isActive: false`). Бэкенд отдаёт `204`, тело пустое.
 */
export function deleteOperation(id: string): Promise<void> {
  return apiFetch<void>(`/operations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
