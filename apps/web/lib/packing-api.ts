/**
 * Серверные обёртки над Nest API для модуля упаковки (Шаг 8).
 *
 * Все функции рассчитаны на использование из RSC / server actions.
 */

import type {
  AddPassportToBoxDto,
  BoxDetailDto,
  BoxStatus,
  BoxesPage,
  CreateBoxDto,
  ListBoxesQuery,
  PlaceBoxDto,
} from '@sewing/shared/packing';
import { apiFetch } from './api';

export function listBoxes(
  query: Partial<ListBoxesQuery> = {},
): Promise<BoxesPage> {
  return apiFetch<BoxesPage>('/packing/boxes', {
    searchParams: {
      status: query.status,
      // `placed` мы передаём как строковый флаг — Zod на сервере сам
      // распарсит в boolean (см. `ListBoxesQuerySchema`). Если поле
      // не задано — параметр не отправляется.
      placed:
        query.placed === undefined
          ? undefined
          : query.placed
            ? 'true'
            : 'false',
      page: query.page,
      pageSize: query.pageSize,
    },
  });
}

export function getBox(id: string): Promise<BoxDetailDto> {
  return apiFetch<BoxDetailDto>(`/packing/boxes/${encodeURIComponent(id)}`);
}

export function createBox(body: CreateBoxDto): Promise<BoxDetailDto> {
  return apiFetch<BoxDetailDto>('/packing/boxes', {
    method: 'POST',
    body,
  });
}

export function addPassportToBox(
  id: string,
  body: AddPassportToBoxDto,
): Promise<BoxDetailDto> {
  return apiFetch<BoxDetailDto>(
    `/packing/boxes/${encodeURIComponent(id)}/add-passport`,
    { method: 'POST', body },
  );
}

export function closeBox(id: string): Promise<BoxDetailDto> {
  return apiFetch<BoxDetailDto>(
    `/packing/boxes/${encodeURIComponent(id)}/close`,
    { method: 'POST', body: {} },
  );
}

export function placeBox(
  id: string,
  body: PlaceBoxDto,
): Promise<BoxDetailDto> {
  return apiFetch<BoxDetailDto>(
    `/packing/boxes/${encodeURIComponent(id)}/place`,
    { method: 'POST', body },
  );
}

export const BOX_STATUS_LABELS: Record<BoxStatus, string> = {
  OPEN: 'Открыта',
  CLOSED: 'Закрыта',
};
