/**
 * Серверные обёртки над Nest API для модуля ОТК (Шаг 7).
 *
 * Все функции рассчитаны на использование из RSC / server actions.
 */

import type {
  CreateDefectTypeDto,
  CreatePassportDefectDto,
  DefectTypeDto,
  ListQcPassportsQuery,
  PassportDefectDto,
  QcIncomingReworkDto,
  QcPassportDetailDto,
  QcPassportListItemDto,
} from '@sewing/shared/qc';
import type {
  CreatePassportQtyCorrectionDto,
  PassportQtyCorrectionDto,
} from '@sewing/shared/passport-qty-corrections';
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

/**
 * Список паспортов, возвращённых мастером на ОТК через backward
 * `set-route-step`. Используется баннером на `/qc`. См.
 * `QcService.listIncomingReworks`.
 */
export function listQcIncomingReworks(): Promise<{
  items: QcIncomingReworkDto[];
}> {
  return apiFetch<{ items: QcIncomingReworkDto[] }>('/qc/incoming-reworks');
}

/**
 * ОТК предлагает корректировку фактического количества по паспорту.
 * Создаёт `PENDING`-заявку, мастеру уходит push. См.
 * `PassportQtyCorrectionsService.create`.
 */
export function createPassportQtyCorrection(
  passportId: string,
  body: CreatePassportQtyCorrectionDto,
): Promise<PassportQtyCorrectionDto> {
  return apiFetch<PassportQtyCorrectionDto>(
    `/qc/passports/${encodeURIComponent(passportId)}/qty-corrections`,
    { method: 'POST', body },
  );
}

/** ОТК отзывает свою открытую заявку на корректировку. */
export function cancelPassportQtyCorrection(
  id: string,
): Promise<PassportQtyCorrectionDto> {
  return apiFetch<PassportQtyCorrectionDto>(
    `/qc/qty-corrections/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body: {} },
  );
}

export function listDefectTypes(): Promise<DefectTypeDto[]> {
  return apiFetch<DefectTypeDto[]>('/defect-types', {
    next: { revalidate: 300, tags: ['defect-types'] },
  });
}

export function createDefectType(
  body: CreateDefectTypeDto,
): Promise<DefectTypeDto> {
  return apiFetch<DefectTypeDto>('/defect-types', {
    method: 'POST',
    body,
  });
}

export function listPassportDefects(
  passportId: string,
): Promise<PassportDefectDto[]> {
  return apiFetch<PassportDefectDto[]>(
    `/passports/${encodeURIComponent(passportId)}/defects`,
  );
}
