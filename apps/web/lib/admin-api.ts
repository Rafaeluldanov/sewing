/**
 * Типизированные обёртки вокруг `apiFetch` под admin / monitoring
 * (Шаг 12 — Pilot Rollout / Bugfix Sprint).
 */

import type { AdminOverviewDto } from '@sewing/shared/admin';
import type { DiagnosticConsistencyReportDto } from '@sewing/shared/diagnostics';
import { apiFetch } from './api';

export function getAdminOverview(): Promise<AdminOverviewDto> {
  return apiFetch<AdminOverviewDto>('/admin/overview', { cache: 'no-store' });
}

/**
 * Diagnostic consistency report (см. `docs/ops.md §«Diagnostics»`).
 * Возвращает список «невозможных» состояний БД для ручного разбора.
 * Read-only: ничего не правит автоматически.
 */
export function getDiagnosticConsistencyReport(): Promise<DiagnosticConsistencyReportDto> {
  return apiFetch<DiagnosticConsistencyReportDto>(
    '/admin/diagnostics/consistency',
    { cache: 'no-store' },
  );
}
