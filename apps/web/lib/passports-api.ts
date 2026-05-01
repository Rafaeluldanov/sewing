/**
 * Серверные обёртки над Nest API для модуля паспортов (Шаг 5).
 *
 * Все функции рассчитаны на использование из RSC / server actions.
 * Клиентские компоненты ходят сюда через server actions (см.
 * `app/orders/[id]/passports/actions.ts`).
 */

import type {
  CellDetailDto,
  CreatePassportDto,
  PassportDetailDto,
  PassportListItemDto,
  PassportPlacementResultDto,
  PlacePassportDto,
} from '@sewing/shared/passports';
import { apiFetch } from './api';

export function createPassport(
  body: CreatePassportDto,
): Promise<PassportDetailDto> {
  return apiFetch<PassportDetailDto>('/passports', {
    method: 'POST',
    body,
  });
}

export function getPassport(id: string): Promise<PassportDetailDto> {
  return apiFetch<PassportDetailDto>(`/passports/${encodeURIComponent(id)}`);
}

export function listOrderPassports(
  orderId: string,
): Promise<PassportListItemDto[]> {
  return apiFetch<PassportListItemDto[]>(
    `/orders/${encodeURIComponent(orderId)}/passports`,
  );
}

export function placePassport(
  id: string,
  body: PlacePassportDto,
): Promise<PassportPlacementResultDto> {
  return apiFetch<PassportPlacementResultDto>(
    `/passports/${encodeURIComponent(id)}/place`,
    { method: 'POST', body },
  );
}

export function listCells(): Promise<CellDetailDto[]> {
  return apiFetch<CellDetailDto[]>('/cells', {
    next: { revalidate: 60, tags: ['cells'] },
  });
}

/**
 * Резолв ячейки по произвольному коду (QR `cell:{id}`, человекочитаемый
 * `code` или голый `id`). Используется на /work в shelf-placement flow
 * помощника раскройщика — backend = источник истины для существования
 * и `active`-флага ячейки (см. `docs/flows.md §F3b`, ADR-0008).
 */
export function findCellByCode(code: string): Promise<CellDetailDto> {
  return apiFetch<CellDetailDto>('/cells/by-code', {
    method: 'POST',
    body: { code },
  });
}

// Лейблы статусов вынесены в browser-safe модуль, чтобы клиентские
// компоненты (`app/qc/qc-work-card.tsx`) не тянули за собой серверный
// `apiFetch` → `next/headers`. Re-export сохраняет совместимость со
// всеми существующими server-side импортами `from '@/lib/passports-api'`.
export { PASSPORT_STATUS_LABELS } from './passport-status-labels';
