/**
 * Серверные обёртки над `/api/help` — читалкой справки для сотрудника
 * (см. `apps/api/src/modules/knowledge/help.controller.ts`).
 *
 * Отдельно от `knowledge-api.ts` намеренно: там ручки управления
 * статьями под `SHOP_MANAGER`/`ADMIN`, здесь — только чтение, доступное
 * любому аутентифицированному. Держать их в одном файле значит однажды
 * позвать не ту.
 */
import type {
  HelpArticleDto,
  HelpSearchResultDto,
  KnowledgeFeedbackDto,
} from '@sewing/shared/knowledge';
import { apiFetch } from './api';

export function fetchHelp(q?: string): Promise<HelpSearchResultDto> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  const qs = params.toString();
  return apiFetch<HelpSearchResultDto>(qs ? `/help?${qs}` : '/help', {
    cache: 'no-store',
  });
}

export function fetchHelpArticle(slug: string): Promise<HelpArticleDto> {
  return apiFetch<HelpArticleDto>(`/help/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
  });
}

export function sendHelpFeedback(
  slug: string,
  body: KnowledgeFeedbackDto,
): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/help/${encodeURIComponent(slug)}/feedback`, {
    method: 'POST',
    body,
  });
}
