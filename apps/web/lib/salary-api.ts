/**
 * Серверные обёртки над Nest API модуля окладных начислений
 * (post-Шаг 18 / Шаг 19, ADR-0021). См. контракты `docs/api.md §10a`.
 *
 * Все функции рассчитаны на использование из RSC / server actions.
 */

import type {
  ListSalaryQuery,
  SalaryEntryDto,
  SalaryPage,
  SalarySummaryDto,
  SalarySummaryQuery,
  UpdateSalaryEntryDto,
} from '@sewing/shared/salary';
import { apiFetch } from './api';

export const SALARY_SOURCE_LABELS: Record<SalaryEntryDto['source'], string> = {
  SHIFT_DAY: 'Оклад за смену',
  MANUAL: 'Ручное начисление',
};

export function listSalary(
  query: Partial<ListSalaryQuery> = {},
): Promise<SalaryPage> {
  return apiFetch<SalaryPage>('/salary', {
    searchParams: {
      employeeId: query.employeeId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      page: query.page,
      pageSize: query.pageSize,
    },
  });
}

export function getSalarySummary(
  query: Partial<SalarySummaryQuery> = {},
): Promise<SalarySummaryDto> {
  return apiFetch<SalarySummaryDto>('/salary/summary', {
    searchParams: {
      employeeId: query.employeeId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    },
  });
}

export function updateSalaryEntry(
  id: string,
  body: UpdateSalaryEntryDto,
): Promise<SalaryEntryDto> {
  return apiFetch<SalaryEntryDto>(`/salary/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}
