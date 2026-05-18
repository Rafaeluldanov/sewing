import 'server-only';
import type {
  ConstructorTaskDetailDto,
  ConstructorTaskListScope,
  ConstructorTaskSummaryDto,
  SaveConstructorDraftResultDto,
} from '@sewing/shared/constructor-tasks';
import { apiFetch, apiFetchMultipart } from './api';

/**
 * Клиент для `/api/constructor-tasks` (этап «Отправить изделие
 * конструктору»). Используется:
 *   - server action-ом `saveConstructorDraftAction` (создание задачи
 *     при «Сохранить изделие» на вкладке `constructor`);
 *   - RSC-страницами `/admin/constructor-tasks` (список / деталь).
 */

export function listConstructorTasks(): Promise<ConstructorTaskSummaryDto[]> {
  return apiFetch<ConstructorTaskSummaryDto[]>('/constructor-tasks');
}

export function getConstructorTask(
  id: string,
): Promise<ConstructorTaskDetailDto> {
  return apiFetch<ConstructorTaskDetailDto>(`/constructor-tasks/${id}`);
}

export function saveConstructorTaskDraft(
  formData: FormData,
  options?: { createDraftOrder?: boolean },
): Promise<SaveConstructorDraftResultDto> {
  const path = options?.createDraftOrder
    ? '/constructor-tasks?createDraftOrder=true'
    : '/constructor-tasks';
  return apiFetchMultipart<SaveConstructorDraftResultDto>(path, formData);
}

export function cancelConstructorTask(
  id: string,
): Promise<ConstructorTaskDetailDto> {
  return apiFetch<ConstructorTaskDetailDto>(
    `/constructor-tasks/${id}/cancel`,
    { method: 'POST' },
  );
}

// ---------------------------------------------------------------------------
// Кабинет конструктора (`apps/web/app/constructor/`)
// ---------------------------------------------------------------------------

export function listConstructorTasksForMe(
  scope: ConstructorTaskListScope = 'all',
): Promise<ConstructorTaskSummaryDto[]> {
  return apiFetch<ConstructorTaskSummaryDto[]>('/constructor-tasks/my', {
    searchParams: { scope },
  });
}

export function assignSelfConstructorTask(
  id: string,
): Promise<ConstructorTaskDetailDto> {
  return apiFetch<ConstructorTaskDetailDto>(
    `/constructor-tasks/${id}/assign-self`,
    { method: 'POST' },
  );
}

export function updateConstructorTaskComment(
  id: string,
  comment: string,
): Promise<ConstructorTaskDetailDto> {
  return apiFetch<ConstructorTaskDetailDto>(
    `/constructor-tasks/${id}/comment`,
    { method: 'PATCH', body: { comment } },
  );
}

export function completeConstructorTask(
  id: string,
  formData: FormData,
): Promise<ConstructorTaskDetailDto> {
  return apiFetchMultipart<ConstructorTaskDetailDto>(
    `/constructor-tasks/${id}/complete`,
    formData,
  );
}

// ---------------------------------------------------------------------------
// Приёмка / возврат на доработку (admin)
// ---------------------------------------------------------------------------

export function acceptConstructorTask(
  id: string,
): Promise<ConstructorTaskDetailDto> {
  return apiFetch<ConstructorTaskDetailDto>(
    `/constructor-tasks/${id}/accept`,
    { method: 'POST' },
  );
}

export function requestReworkConstructorTask(
  id: string,
  formData: FormData,
): Promise<ConstructorTaskDetailDto> {
  return apiFetchMultipart<ConstructorTaskDetailDto>(
    `/constructor-tasks/${id}/rework`,
    formData,
  );
}
