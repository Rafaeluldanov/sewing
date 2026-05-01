/**
 * Серверные обёртки над `/api/purchase-receipts/*`,
 * `/api/purchase-orders/:id/receipts` и
 * `/api/orders/:id/purchase-receipts` (см. модуль
 * `apps/api/src/modules/purchase-receipts/*`).
 *
 * Используется из RSC (`/admin/purchase-receipts/*`, блок
 * «Поступления» в карточке заказа покупателя и в карточке
 * заказа поставщику) и из server actions (создание/отмена
 * приёмки). Контракты — те же Zod-схемы из
 * `@sewing/shared/purchase-receipts`, что валидирует backend.
 */
import type {
  CancelPurchaseReceiptDto,
  CreatePurchaseReceiptFromPurchaseOrderDto,
  ListPurchaseReceiptsQuery,
  PurchaseReceiptDetailDto,
  PurchaseReceiptListItemDto,
} from '@sewing/shared/purchase-receipts';
import { apiFetch } from './api';

export function listPurchaseReceipts(
  query: ListPurchaseReceiptsQuery = {},
): Promise<PurchaseReceiptListItemDto[]> {
  return apiFetch<PurchaseReceiptListItemDto[]>('/purchase-receipts', {
    cache: 'no-store',
    searchParams: {
      search: query.search,
      status: query.status,
      purchaseOrderId: query.purchaseOrderId,
      customerOrderId: query.customerOrderId,
      supplierId: query.supplierId,
      cellId: query.cellId,
    },
  });
}

export function getPurchaseReceipt(
  id: string,
): Promise<PurchaseReceiptDetailDto> {
  return apiFetch<PurchaseReceiptDetailDto>(
    `/purchase-receipts/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createPurchaseReceiptFromPurchaseOrder(
  body: CreatePurchaseReceiptFromPurchaseOrderDto,
): Promise<PurchaseReceiptDetailDto> {
  return apiFetch<PurchaseReceiptDetailDto>(
    '/purchase-receipts/from-purchase-order',
    { method: 'POST', body },
  );
}

export function cancelPurchaseReceipt(
  id: string,
  body: CancelPurchaseReceiptDto = {},
): Promise<PurchaseReceiptDetailDto> {
  return apiFetch<PurchaseReceiptDetailDto>(
    `/purchase-receipts/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body },
  );
}

export function getPurchaseOrderReceipts(
  purchaseOrderId: string,
): Promise<PurchaseReceiptListItemDto[]> {
  return apiFetch<PurchaseReceiptListItemDto[]>(
    `/purchase-orders/${encodeURIComponent(purchaseOrderId)}/receipts`,
    { cache: 'no-store' },
  );
}

export function getOrderPurchaseReceipts(
  customerOrderId: string,
): Promise<PurchaseReceiptListItemDto[]> {
  return apiFetch<PurchaseReceiptListItemDto[]>(
    `/orders/${encodeURIComponent(customerOrderId)}/purchase-receipts`,
    { cache: 'no-store' },
  );
}
