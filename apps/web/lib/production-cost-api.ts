/**
 * Серверная обёртка над Nest API управленческого отчёта
 * «Себестоимость производства v2» (см.
 * `docs/production-cost-v2-recon.md`,
 * `apps/api/src/modules/costs/production-cost-v2.controller.ts`).
 *
 * Read-only, доступ — `ADMIN` / `SHOP_MANAGER` (RBAC backend).
 *
 * Используется из RSC `apps/web/app/admin/production-cost/page.tsx`.
 */

import type {
  ProductionCostReportDto,
  ProductionCostV2Query,
} from '@sewing/shared/production-cost';
import { apiFetch } from './api';

export function getProductionCostV2(
  query: Partial<ProductionCostV2Query> = {},
): Promise<ProductionCostReportDto> {
  return apiFetch<ProductionCostReportDto>('/admin/production-cost/v2', {
    searchParams: {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      patternItemId: query.patternItemId,
      orderId: query.orderId,
      clientId: query.clientId,
      employeeId: query.employeeId,
      operationId: query.operationId,
      status: query.status,
    },
  });
}
