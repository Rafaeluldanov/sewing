/**
 * Серверная обёртка над `GET /api/costs/actual-materials`
 * (см. `apps/api/src/modules/costs/order-actual-materials.controller.ts`).
 *
 * Себестоимость, Фаза 2 — отчёт «Материалы план → факт по заказу».
 * Read-only, RBAC `SHOP_MANAGER`/`ADMIN` на backend.
 */
import type { OrderActualMaterialsReportDto } from '@sewing/shared/order-actual-materials';
import { apiFetch } from './api';

/**
 * `dateFrom`/`dateTo` (`YYYY-MM-DD`) — окно проводок для пула накладных.
 * Без обеих границ backend накладные не распределяет: пул накопительный
 * за всю историю, и раздутое число хуже отсутствующего.
 */
export function getOrderActualMaterials(params?: {
  dateFrom?: string;
  dateTo?: string;
}): Promise<OrderActualMaterialsReportDto> {
  const qs = new URLSearchParams();
  if (params?.dateFrom) qs.set('dateFrom', params.dateFrom);
  if (params?.dateTo) qs.set('dateTo', params.dateTo);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch<OrderActualMaterialsReportDto>(
    `/costs/actual-materials${suffix}`,
    { cache: 'no-store' },
  );
}
