/**
 * Серверные обёртки над Nest API модуля `cut-release-policy`
 * (Stage 3 «Мастер цеха»).
 *
 * Контракт — `apps/api/src/modules/cut-release-policy/*`,
 * `@sewing/shared/cut-release-policy`. Используются server actions
 * (`apps/web/app/master/cut-release-policy-actions.ts`) и серверной
 * частью карточки на `/master`.
 */

import type {
  CreateCutReleasePolicyDto,
  CutReleasePolicyDto,
  UpdateCutReleasePolicyDto,
} from '@sewing/shared';
import { apiFetch } from './api';

export function getActiveCutReleasePolicy(): Promise<{
  policy: CutReleasePolicyDto | null;
}> {
  return apiFetch<{ policy: CutReleasePolicyDto | null }>(
    '/cut-release-policy',
    { cache: 'no-store' },
  );
}

export function createCutReleasePolicy(
  body: CreateCutReleasePolicyDto,
): Promise<CutReleasePolicyDto> {
  return apiFetch<CutReleasePolicyDto>('/cut-release-policy', {
    method: 'POST',
    body,
  });
}

export function updateCutReleasePolicy(
  id: string,
  body: UpdateCutReleasePolicyDto,
): Promise<CutReleasePolicyDto> {
  return apiFetch<CutReleasePolicyDto>(
    `/cut-release-policy/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

export function disableCutReleasePolicy(
  id: string,
): Promise<CutReleasePolicyDto> {
  return apiFetch<CutReleasePolicyDto>(
    `/cut-release-policy/${encodeURIComponent(id)}/disable`,
    { method: 'POST' },
  );
}
