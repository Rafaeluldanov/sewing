/**
 * Серверные обёртки над `/api/knowledge` (см.
 * `apps/api/src/modules/knowledge/knowledge.controller.ts`).
 *
 * Используется из RSC (`/admin/knowledge/*`) и из server actions
 * создания/правки статьи. Контракты — те же Zod-схемы из
 * `@sewing/shared/knowledge`, что валидирует backend.
 */
import type { BulkArchiveResultDto } from '@sewing/shared/archive';
import type {
  CreateKnowledgeArticleDto,
  KnowledgeArticleDto,
  KnowledgeSearchHitDto,
  ListKnowledgeQuery,
  UpdateKnowledgeArticleDto,
} from '@sewing/shared/knowledge';
import { apiFetch } from './api';

export function listKnowledgeArticles(
  query: ListKnowledgeQuery = {},
): Promise<KnowledgeArticleDto[]> {
  const params = new URLSearchParams();
  if (query.tab) params.set('tab', query.tab);
  if (query.search) params.set('search', query.search);
  if (query.area) params.set('area', query.area);
  const qs = params.toString();
  return apiFetch<KnowledgeArticleDto[]>(
    qs.length > 0 ? `/knowledge?${qs}` : '/knowledge',
    { cache: 'no-store' },
  );
}

export function getKnowledgeArticle(id: string): Promise<KnowledgeArticleDto> {
  return apiFetch<KnowledgeArticleDto>(`/knowledge/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
}

export function searchKnowledge(
  q: string,
  limit?: number,
): Promise<KnowledgeSearchHitDto[]> {
  const params = new URLSearchParams({ q });
  if (limit !== undefined) params.set('limit', String(limit));
  return apiFetch<KnowledgeSearchHitDto[]>(
    `/knowledge/search?${params.toString()}`,
    { cache: 'no-store' },
  );
}

export function createKnowledgeArticle(
  body: CreateKnowledgeArticleDto,
): Promise<KnowledgeArticleDto> {
  return apiFetch<KnowledgeArticleDto>('/knowledge', {
    method: 'POST',
    body,
  });
}

export function updateKnowledgeArticle(
  id: string,
  body: UpdateKnowledgeArticleDto,
): Promise<KnowledgeArticleDto> {
  return apiFetch<KnowledgeArticleDto>(`/knowledge/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

/** «Актуально» — подтверждение без правки текста, в один клик. */
export function confirmKnowledgeReview(
  id: string,
): Promise<KnowledgeArticleDto> {
  return apiFetch<KnowledgeArticleDto>(
    `/knowledge/${encodeURIComponent(id)}/review`,
    { method: 'POST' },
  );
}

export function archiveKnowledgeArticles(
  ids: string[],
): Promise<BulkArchiveResultDto> {
  return apiFetch<BulkArchiveResultDto>('/knowledge/archive', {
    method: 'POST',
    body: { ids },
  });
}

export function restoreKnowledgeArticles(
  ids: string[],
): Promise<BulkArchiveResultDto> {
  return apiFetch<BulkArchiveResultDto>('/knowledge/restore', {
    method: 'POST',
    body: { ids },
  });
}

export function purgeKnowledgeArticles(
  ids: string[],
): Promise<BulkArchiveResultDto> {
  return apiFetch<BulkArchiveResultDto>('/knowledge/purge', {
    method: 'POST',
    body: { ids },
  });
}
