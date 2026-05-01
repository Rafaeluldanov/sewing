/**
 * Серверные обёртки над Nest API для модуля начислений (Шаг 9).
 *
 * Все функции рассчитаны на использование из RSC / server actions.
 * Соответствует контрактам `docs/api.md §10`.
 */

import type {
  EarningDto,
  EarningsPage,
  EarningsSummaryDto,
  EarningsSummaryQuery,
  ListEarningsQuery,
} from '@sewing/shared/earnings';
import { apiFetch } from './api';

export const EARNING_STATUS_LABELS: Record<EarningDto['status'], string> = {
  PENDING_RELEASE: 'Ожидает выпуск',
  APPROVED: 'Подтверждено',
  REVERSED: 'Сторнировано',
};

export const APPROVAL_MODE_LABELS: Record<EarningDto['approvalMode'], string> = {
  IMMEDIATE: 'Сразу',
  AFTER_RELEASE: 'После упаковки',
};

export function listEarnings(
  query: Partial<ListEarningsQuery> = {},
): Promise<EarningsPage> {
  return apiFetch<EarningsPage>('/earnings', {
    searchParams: {
      employeeId: query.employeeId,
      passportId: query.passportId,
      status: query.status,
      approvalMode: query.approvalMode,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      page: query.page,
      pageSize: query.pageSize,
    },
  });
}

export function getEarningsSummary(
  query: Partial<EarningsSummaryQuery> = {},
): Promise<EarningsSummaryDto> {
  return apiFetch<EarningsSummaryDto>('/earnings/summary', {
    searchParams: {
      employeeId: query.employeeId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    },
  });
}

export function listPassportEarnings(
  passportId: string,
): Promise<EarningDto[]> {
  return apiFetch<EarningDto[]>(
    `/passports/${encodeURIComponent(passportId)}/earnings`,
  );
}
