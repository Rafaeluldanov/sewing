/**
 * Серверные обёртки над Nest API «Корректировка количества» для
 * стороны мастера цеха (очередь + подтверждение/отклонение).
 *
 * Рассчитаны на использование из RSC / server actions.
 */

import type {
  ApprovePassportQtyCorrectionResultDto,
  PassportQtyCorrectionDto,
  ReviewPassportQtyCorrectionDto,
} from '@sewing/shared/passport-qty-corrections';
import { apiFetch } from './api';

/** Очередь открытых (`PENDING`) корректировок для мастера. */
export function listPendingQtyCorrections(): Promise<
  PassportQtyCorrectionDto[]
> {
  return apiFetch<PassportQtyCorrectionDto[]>('/master-qty-corrections');
}

/** Мастер подтверждает корректировку — применяется во всём следе. */
export function approveQtyCorrection(
  id: string,
  body: ReviewPassportQtyCorrectionDto = {},
): Promise<ApprovePassportQtyCorrectionResultDto> {
  return apiFetch<ApprovePassportQtyCorrectionResultDto>(
    `/master-qty-corrections/${encodeURIComponent(id)}/approve`,
    { method: 'POST', body },
  );
}

/** Мастер отклоняет корректировку. */
export function rejectQtyCorrection(
  id: string,
  body: ReviewPassportQtyCorrectionDto = {},
): Promise<PassportQtyCorrectionDto> {
  return apiFetch<PassportQtyCorrectionDto>(
    `/master-qty-corrections/${encodeURIComponent(id)}/reject`,
    { method: 'POST', body },
  );
}
