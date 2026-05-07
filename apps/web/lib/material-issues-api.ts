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
  MaterialIssueReturnDto,
  ReturnMaterialIssueDto,
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

/**
 * `POST /api/material-issues/:id/return` — полное сторно
 * проведённого расхода (см. `apps/api/src/modules/material-issues/material-issues.controller.ts`,
 * `docs/api.md §«Material issues»`). Возвращает detail созданного
 * (или ранее созданного — идемпотентно по `clientRequestId`)
 * `MaterialIssueReturn`.
 */
export function returnMaterialIssue(
  id: string,
  body: ReturnMaterialIssueDto,
): Promise<MaterialIssueReturnDto> {
  return apiFetch<MaterialIssueReturnDto>(
    `/material-issues/${encodeURIComponent(id)}/return`,
    {
      method: 'POST',
      body,
    },
  );
}
