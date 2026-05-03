/**
 * Серверные обёртки над `/api/material-issues/*` и
 * `/api/orders/:id/material-issues` (см.
 * `apps/api/src/modules/material-issues/*`,
 * `docs/api.md §20a «Material issues»`).
 *
 * Frontend-итерация MVP: UI-блок «Фактический расход материалов»
 * живёт только в карточке заказа, во вкладке «Потребности». Эти
 * обёртки используются RSC-компонентом `MaterialIssuesSection` и
 * server actions `material-issues-actions.ts`. Контракты — те же
 * Zod-схемы из `@sewing/shared/material-issues`, что валидирует
 * backend.
 */
import type {
  CancelMaterialIssueDto,
  CreateMaterialIssueDto,
  ListMaterialIssuesQuery,
  MaterialIssueDetailDto,
  MaterialIssueListItemDto,
} from '@sewing/shared/material-issues';
import { apiFetch } from './api';

export function listMaterialIssues(
  query: ListMaterialIssuesQuery = {},
): Promise<MaterialIssueListItemDto[]> {
  return apiFetch<MaterialIssueListItemDto[]>('/material-issues', {
    cache: 'no-store',
    searchParams: {
      orderId: query.orderId,
      passportId: query.passportId,
      status: query.status,
    },
  });
}

/**
 * Список документов расхода по конкретному заказу
 * (`GET /api/orders/:orderId/material-issues`). На frontend-итерации
 * это основной fetch для блока «Фактический расход материалов» в
 * карточке заказа.
 */
export function listOrderMaterialIssues(
  orderId: string,
): Promise<MaterialIssueListItemDto[]> {
  return apiFetch<MaterialIssueListItemDto[]>(
    `/orders/${encodeURIComponent(orderId)}/material-issues`,
    { cache: 'no-store' },
  );
}

export function getMaterialIssue(
  id: string,
): Promise<MaterialIssueDetailDto> {
  return apiFetch<MaterialIssueDetailDto>(
    `/material-issues/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createMaterialIssue(
  body: CreateMaterialIssueDto,
): Promise<MaterialIssueDetailDto> {
  return apiFetch<MaterialIssueDetailDto>('/material-issues', {
    method: 'POST',
    body,
  });
}

export function postMaterialIssue(
  id: string,
): Promise<MaterialIssueDetailDto> {
  return apiFetch<MaterialIssueDetailDto>(
    `/material-issues/${encodeURIComponent(id)}/post`,
    { method: 'POST' },
  );
}

export function cancelMaterialIssue(
  id: string,
  body: CancelMaterialIssueDto = {},
): Promise<MaterialIssueDetailDto> {
  return apiFetch<MaterialIssueDetailDto>(
    `/material-issues/${encodeURIComponent(id)}/cancel`,
    {
      method: 'POST',
      body,
    },
  );
}
