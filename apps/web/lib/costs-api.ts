/**
 * Серверная обёртка над Nest API модуля «Себестоимость выпуска»
 * (`docs/api.md §17`). Read-only, доступно только `SHOP_MANAGER`/`ADMIN`
 * по RBAC backend (см. `apps/api/src/modules/costs/costs.controller.ts`).
 *
 * Используется из RSC `apps/web/app/production-cost/page.tsx`.
 */

import type {
  PassportCostDto,
  ProductionCostQuery,
  ProductionCostResponseDto,
} from '@sewing/shared/costs';
import { apiFetch } from './api';

export function getProductionCost(
  query: Partial<ProductionCostQuery> = {},
): Promise<ProductionCostResponseDto> {
  return apiFetch<ProductionCostResponseDto>('/costs/production', {
    searchParams: {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    },
  });
}

/**
 * Фактическая себестоимость одного паспорта (материал + сдельная +
 * разнесённый оклад) с детализацией окладной части. RBAC backend —
 * `SHOP_MANAGER`/`ADMIN` (см. `costs.controller.ts`).
 */
export function getPassportCost(passportId: string): Promise<PassportCostDto> {
  return apiFetch<PassportCostDto>(
    `/costs/passport/${encodeURIComponent(passportId)}`,
  );
}
