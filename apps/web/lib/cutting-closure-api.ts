/**
 * Серверные обёртки над Nest API для модуля «Закрытие раскроя по
 * размеру через заявку» (ADR-0018, `docs/api.md §14`).
 *
 * Используются из RSC / server actions. Клиентские компоненты ходят
 * сюда через `app/passports/[id]/cutting-closure-actions.ts`.
 */

import type {
  CreateCuttingClosureRequestDto,
  CuttingClosureRequestDto,
  ListCuttingClosureRequestsQuery,
  ReviewCuttingClosureRequestDto,
} from '@sewing/shared/cutting-closure';
import { apiFetch } from './api';

export function createCuttingClosureRequest(
  body: CreateCuttingClosureRequestDto,
): Promise<CuttingClosureRequestDto> {
  return apiFetch<CuttingClosureRequestDto>('/cutting-close-requests', {
    method: 'POST',
    body,
  });
}

export function listCuttingClosureRequests(
  query: ListCuttingClosureRequestsQuery = {},
): Promise<CuttingClosureRequestDto[]> {
  return apiFetch<CuttingClosureRequestDto[]>('/cutting-close-requests', {
    searchParams: {
      status: query.status,
      orderId: query.orderId,
      productId: query.productId,
      sizeId: query.sizeId,
    },
  });
}

export function approveCuttingClosureRequest(
  id: string,
  body: ReviewCuttingClosureRequestDto = {},
): Promise<CuttingClosureRequestDto> {
  return apiFetch<CuttingClosureRequestDto>(
    `/cutting-close-requests/${encodeURIComponent(id)}/approve`,
    { method: 'POST', body },
  );
}

export function rejectCuttingClosureRequest(
  id: string,
  body: ReviewCuttingClosureRequestDto = {},
): Promise<CuttingClosureRequestDto> {
  return apiFetch<CuttingClosureRequestDto>(
    `/cutting-close-requests/${encodeURIComponent(id)}/reject`,
    { method: 'POST', body },
  );
}

export function getPassportCuttingClosureRequest(
  passportId: string,
): Promise<CuttingClosureRequestDto | null> {
  return apiFetch<CuttingClosureRequestDto | null>(
    `/passports/${encodeURIComponent(passportId)}/cutting-closure-request`,
  );
}
