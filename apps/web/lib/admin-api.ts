/**
 * Типизированные обёртки вокруг `apiFetch` под admin / monitoring
 * (Шаг 12 — Pilot Rollout / Bugfix Sprint).
 */

import type { AdminOverviewDto } from '@sewing/shared/admin';
import { apiFetch } from './api';

export function getAdminOverview(): Promise<AdminOverviewDto> {
  return apiFetch<AdminOverviewDto>('/admin/overview', { cache: 'no-store' });
}
