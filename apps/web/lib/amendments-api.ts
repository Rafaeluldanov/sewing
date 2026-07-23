/**
 * Серверные обёртки над Nest API модуля «Правка заказа в производстве»
 * (`/api/orders/:id/amendments/*`). Контракт — `@sewing/shared/amendments`,
 * бэкенд — `apps/api/src/modules/order-amendments/*`.
 *
 * ФАЗА 1 — количество по размерам: GET состояния (для drawer-а) и POST
 * применения правки.
 */

import type {
  AmendmentHistoryEntryDto,
  ApplyOperationAmendmentDto,
  ApplyQuantityAmendmentDto,
  ApplySizeAmendmentDto,
  OperationAmendmentResultDto,
  OperationAmendmentStateDto,
  QuantityAmendmentResultDto,
  QuantityAmendmentStateDto,
  SizeAmendmentResultDto,
  SizeAmendmentStateDto,
} from '@sewing/shared';
import { apiFetch } from './api';

export function getAmendmentHistory(
  orderId: string,
): Promise<AmendmentHistoryEntryDto[]> {
  return apiFetch<AmendmentHistoryEntryDto[]>(
    `/orders/${encodeURIComponent(orderId)}/amendments/history`,
    { cache: 'no-store' },
  );
}

export function getQuantityAmendmentState(
  orderId: string,
): Promise<QuantityAmendmentStateDto> {
  return apiFetch<QuantityAmendmentStateDto>(
    `/orders/${encodeURIComponent(orderId)}/amendments/quantities`,
    { cache: 'no-store' },
  );
}

export function applyQuantityAmendment(
  orderId: string,
  body: ApplyQuantityAmendmentDto,
): Promise<QuantityAmendmentResultDto> {
  return apiFetch<QuantityAmendmentResultDto>(
    `/orders/${encodeURIComponent(orderId)}/amendments/quantities`,
    { method: 'POST', body },
  );
}

export function getSizeAmendmentState(
  orderId: string,
): Promise<SizeAmendmentStateDto> {
  return apiFetch<SizeAmendmentStateDto>(
    `/orders/${encodeURIComponent(orderId)}/amendments/sizes`,
    { cache: 'no-store' },
  );
}

export function applySizeAmendment(
  orderId: string,
  body: ApplySizeAmendmentDto,
): Promise<SizeAmendmentResultDto> {
  return apiFetch<SizeAmendmentResultDto>(
    `/orders/${encodeURIComponent(orderId)}/amendments/sizes`,
    { method: 'POST', body },
  );
}

export function getOperationAmendmentState(
  orderId: string,
): Promise<OperationAmendmentStateDto> {
  return apiFetch<OperationAmendmentStateDto>(
    `/orders/${encodeURIComponent(orderId)}/amendments/operations`,
    { cache: 'no-store' },
  );
}

export function applyOperationAmendment(
  orderId: string,
  body: ApplyOperationAmendmentDto,
): Promise<OperationAmendmentResultDto> {
  return apiFetch<OperationAmendmentResultDto>(
    `/orders/${encodeURIComponent(orderId)}/amendments/operations`,
    { method: 'POST', body },
  );
}
