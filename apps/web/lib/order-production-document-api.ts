/**
 * Серверная обёртка над `GET /api/admin/production-cost/order/:orderId/document`
 * (см. `apps/api/src/modules/costs/production-cost-v2.controller.ts`,
 * `order-production-document.service.ts`).
 *
 * «Документ производства по заказу» — план → факт построчно. Read-only,
 * RBAC `ADMIN`/`SHOP_MANAGER` на backend. Используется из RSC
 * `apps/web/app/admin/production-cost/order/[orderId]/page.tsx`.
 */
import type { OrderProductionDocumentDto } from '@sewing/shared/order-production-document';
import { apiFetch } from './api';

export function getOrderProductionDocument(
  orderId: string,
): Promise<OrderProductionDocumentDto> {
  return apiFetch<OrderProductionDocumentDto>(
    `/admin/production-cost/order/${encodeURIComponent(orderId)}/document`,
    { cache: 'no-store' },
  );
}
