/**
 * Серверные обёртки над модулем «Заявки на оплату поставщику» (см.
 * `apps/api/src/modules/supplier-payment-requests/*`):
 *   GET  /purchase-orders/:id/payment-requests — список по заказу;
 *   GET  /supplier-payment-requests/:id — детальная карточка;
 *   POST /purchase-orders/:id/payment-requests — создание (multipart).
 *
 * Используется из RSC (карточка заказа поставщику) и из server action
 * создания заявки.
 */
import type {
  SupplierPaymentRequestDetailDto,
  SupplierPaymentRequestListItemDto,
} from '@sewing/shared/supplier-payment-requests';
import { apiFetch, apiFetchMultipart } from './api';

export function listPurchaseOrderPaymentRequests(
  purchaseOrderId: string,
): Promise<SupplierPaymentRequestListItemDto[]> {
  return apiFetch<SupplierPaymentRequestListItemDto[]>(
    `/purchase-orders/${encodeURIComponent(purchaseOrderId)}/payment-requests`,
    { cache: 'no-store' },
  );
}

export function getSupplierPaymentRequest(
  id: string,
): Promise<SupplierPaymentRequestDetailDto> {
  return apiFetch<SupplierPaymentRequestDetailDto>(
    `/supplier-payment-requests/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

/**
 * Создать заявку на оплату. `formData` собирается на клиенте (поле
 * `payload` с JSON + повторяющееся поле `files`) и форвардится как один
 * аргумент — Next 14 не принимает `File[]` top-level (см. memory
 * `feedback-server-action-file-array`).
 */
export function createSupplierPaymentRequest(
  purchaseOrderId: string,
  formData: FormData,
): Promise<SupplierPaymentRequestDetailDto> {
  return apiFetchMultipart<SupplierPaymentRequestDetailDto>(
    `/purchase-orders/${encodeURIComponent(purchaseOrderId)}/payment-requests`,
    formData,
  );
}
