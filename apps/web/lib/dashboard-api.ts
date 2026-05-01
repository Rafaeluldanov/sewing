/**
 * Серверная обёртка над `/api/dashboard/production` (см. `docs/api.md §11b`).
 *
 * Read-only, доступно только `SHOP_MANAGER` / `ADMIN` по RBAC backend
 * (см. `apps/api/src/modules/dashboard/dashboard.controller.ts`).
 * Используется из RSC `apps/web/app/admin/production-dashboard/page.tsx`.
 */

import type {
  ProductionDashboardDto,
  ProductionDashboardPeriod,
} from '@sewing/shared/dashboard';
import { apiFetch } from './api';

export function getProductionDashboard(
  query: { days?: ProductionDashboardPeriod } = {},
): Promise<ProductionDashboardDto> {
  return apiFetch<ProductionDashboardDto>('/dashboard/production', {
    cache: 'no-store',
    searchParams: { days: query.days },
  });
}
