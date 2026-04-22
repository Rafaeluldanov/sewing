/**
 * Серверные обёртки над `/api/tech-cards` (см. `docs/api.md §«tech-cards»`,
 * ADR-0022).
 *
 * Используется из RSC (`/admin/tech-cards/*`, `/orders/new`,
 * `/orders/[id]/edit`) и из server actions редактирования шаблонов.
 * Контракты — те же Zod-схемы из `@sewing/shared/tech-cards`, что
 * валидирует backend.
 */
import type {
  CreateTechCardDto,
  ListTechCardsQuery,
  TechCardTemplateDetailDto,
  TechCardTemplateSummaryDto,
  UpdateTechCardDto,
} from '@sewing/shared/tech-cards';
import { apiFetch } from './api';

export function listTechCards(
  query: ListTechCardsQuery = {},
): Promise<TechCardTemplateSummaryDto[]> {
  const params = new URLSearchParams();
  if (query.isActive !== undefined) {
    params.set('isActive', String(query.isActive));
  }
  if (query.search) params.set('search', query.search);
  const qs = params.toString();
  const path = qs.length > 0 ? `/tech-cards?${qs}` : '/tech-cards';
  return apiFetch<TechCardTemplateSummaryDto[]>(path, { cache: 'no-store' });
}

export function getTechCard(id: string): Promise<TechCardTemplateDetailDto> {
  return apiFetch<TechCardTemplateDetailDto>(
    `/tech-cards/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createTechCard(
  body: CreateTechCardDto,
): Promise<TechCardTemplateDetailDto> {
  return apiFetch<TechCardTemplateDetailDto>('/tech-cards', {
    method: 'POST',
    body,
  });
}

export function updateTechCard(
  id: string,
  body: UpdateTechCardDto,
): Promise<TechCardTemplateDetailDto> {
  return apiFetch<TechCardTemplateDetailDto>(
    `/tech-cards/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}
