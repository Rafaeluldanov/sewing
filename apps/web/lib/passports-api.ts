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
  MyPassportListItem,
  PassportDetailDto,
  PassportListItemDto,
  PassportPlacementResultDto,
  PlacePassportDto,
  UpdatePassportDto,
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

/**
 * `PATCH /api/passports/:id` — обновление полей паспорта силами
 * автора (CUTTER_ASSISTANT/CUTTER) или менеджера. Backend разрешает
 * только пока паспорт ещё в статусе CREATED, без ячейки и без
 * событий кроме CREATED. См. `PassportsService.update`.
 */
export function updatePassport(
  id: string,
  body: UpdatePassportDto,
): Promise<PassportDetailDto> {
  return apiFetch<PassportDetailDto>(`/passports/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

/**
 * `GET /api/passports/my-recent` — последние паспорта, выпущенные
 * самим actor-ом. Используется страницей `/work/passports`. Backend
 * сужает RBAC до `CUTTER_ASSISTANT` / `CUTTER` / `SHOP_MANAGER` /
 * `ADMIN`; для всех «нерабочих» ролей вызов вернёт 403, что мы здесь
 * не глотаем — пусть страница сама решит, как себя вести.
 */
export function listMyRecentPassports(): Promise<MyPassportListItem[]> {
  return apiFetch<MyPassportListItem[]>('/passports/my-recent', {
    cache: 'no-store',
  });
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

/**
 * Управленческое удаление паспорта (см.
 * `PassportsService.delete`, `docs/api.md §«DELETE /api/passports/:id»`).
 * RBAC: `SHOP_MANAGER` / `ADMIN`. Backend отвечает `204 No Content`,
 * `apiFetch` для пустого тела возвращает `null`-friendly значение —
 * мы намеренно ничего не используем, важен сам факт `2xx`.
 */
export async function deletePassport(id: string): Promise<void> {
  await apiFetch<unknown>(`/passports/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
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
