/**
 * Серверная обёртка над `GET /api/costs/actual-materials`
 * (см. `apps/api/src/modules/costs/order-actual-materials.controller.ts`).
 *
 * Себестоимость, Фаза 2 — отчёт «Материалы план → факт по заказу».
 * Read-only, RBAC `SHOP_MANAGER`/`ADMIN` на backend.
 */
import type { OrderActualMaterialsReportDto } from '@sewing/shared/order-actual-materials';
import { apiFetch } from './api';

export function getOrderActualMaterials(): Promise<OrderActualMaterialsReportDto> {
  return apiFetch<OrderActualMaterialsReportDto>('/costs/actual-materials', {
    cache: 'no-store',
  });
}
