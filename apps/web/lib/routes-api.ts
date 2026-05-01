/**
 * Серверные обёртки над `/api/routes` (см. `docs/api.md §«routes»`).
 *
 * Используется из RSC (`/admin/routes/*`) и из server actions
 * редактирования шаблонов / выбора шаблона на форме создания заказа.
 * Контракты — те же Zod-схемы из `@sewing/shared/routes`, что
 * валидирует backend.
 */
import type {
  CreateRouteTemplateDto,
  ListRouteTemplatesQuery,
  RouteTemplateDetailDto,
  RouteTemplateSummaryDto,
  UpdateRouteTemplateDto,
} from '@sewing/shared/routes';
import { apiFetch } from './api';

export function listRouteTemplates(
  query: ListRouteTemplatesQuery = {},
): Promise<RouteTemplateSummaryDto[]> {
  const params = new URLSearchParams();
  if (query.isActive !== undefined) {
    params.set('isActive', String(query.isActive));
  }
  if (query.search) params.set('search', query.search);
  const qs = params.toString();
  const path = qs.length > 0 ? `/routes?${qs}` : '/routes';
  return apiFetch<RouteTemplateSummaryDto[]>(path, { cache: 'no-store' });
}

export function getRouteTemplate(id: string): Promise<RouteTemplateDetailDto> {
  return apiFetch<RouteTemplateDetailDto>(
    `/routes/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createRouteTemplate(
  body: CreateRouteTemplateDto,
): Promise<RouteTemplateDetailDto> {
  return apiFetch<RouteTemplateDetailDto>('/routes', {
    method: 'POST',
    body,
  });
}

export function updateRouteTemplate(
  id: string,
  body: UpdateRouteTemplateDto,
): Promise<RouteTemplateDetailDto> {
  return apiFetch<RouteTemplateDetailDto>(
    `/routes/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

export function deleteRouteTemplate(id: string): Promise<void> {
  return apiFetch<void>(`/routes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
