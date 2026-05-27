/**
 * Серверные обёртки над Nest API для модуля ОТК (Шаг 7).
 *
 * Все функции рассчитаны на использование из RSC / server actions.
 */

import type {
  CreatePassportDefectDto,
  DefectTypeDto,
  ListQcPassportsQuery,
  PassportDefectDto,
  QcPassportDetailDto,
  QcPassportListItemDto,
} from '@sewing/shared/qc';
import { apiFetch } from './api';

export interface QcPassportListResponse {
  items: QcPassportListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

export function listQcPassports(
  query: Partial<ListQcPassportsQuery> = {},
): Promise<QcPassportListResponse> {
  return apiFetch<QcPassportListResponse>('/qc/passports', {
    searchParams: {
      search: query.search,
      orderId: query.orderId,
      page: query.page,
      pageSize: query.pageSize,
    },
  });
}

export function getQcPassport(id: string): Promise<QcPassportDetailDto> {
  return apiFetch<QcPassportDetailDto>(
    `/qc/passports/${encodeURIComponent(id)}`,
  );
}

export function recordPassportDefect(
  id: string,
  body: CreatePassportDefectDto,
): Promise<QcPassportDetailDto> {
  return apiFetch<QcPassportDetailDto>(
    `/qc/passports/${encodeURIComponent(id)}/defects`,
    { method: 'POST', body },
  );
}

/**
 * QC role-terminal: «Проверка выполнена». Body пустой — актор
 * берётся из сессии. См. `QcService.completeQc`.
 */
export function completeQcPassport(id: string): Promise<QcPassportDetailDto> {
  return apiFetch<QcPassportDetailDto>(
    `/qc/passports/${encodeURIComponent(id)}/complete`,
    { method: 'POST', body: {} },
  );
}

/**
 * QC role-terminal: «Вернуть на переделку». Body — `targetOperationId`
 * (одна из `QcPassportDetailDto.eligibleReworkTargets`). Бэк сам
 * определяет швею-получателя из последнего `OPERATION_FINISHED` для
 * этой операции. См. `QcService.returnToRework`.
 */
export function returnQcPassportToRework(
  id: string,
  targetOperationId: string,
): Promise<QcPassportDetailDto> {
  return apiFetch<QcPassportDetailDto>(
    `/qc/passports/${encodeURIComponent(id)}/return-to-rework`,
    { method: 'POST', body: { targetOperationId } },
  );
}

export function listDefectTypes(): Promise<DefectTypeDto[]> {
  return apiFetch<DefectTypeDto[]>('/defect-types', {
    next: { revalidate: 300, tags: ['defect-types'] },
  });
}

export function listPassportDefects(
  passportId: string,
): Promise<PassportDefectDto[]> {
  return apiFetch<PassportDefectDto[]>(
    `/passports/${encodeURIComponent(passportId)}/defects`,
  );
}
