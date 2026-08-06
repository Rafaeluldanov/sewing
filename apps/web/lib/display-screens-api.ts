/**
 * Серверные обёртки над Nest API блока «Display screens» (большие
 * мониторы цеха). См. контракты `docs/api.md §11`.
 *
 * Используются из RSC `/admin/display-screens` и server actions
 * страницы создания экрана `/admin/display-screens/new`.
 */

import type {
  CreateDisplayScreenDto,
  DisplayScreenDetailDto,
  DisplayScreenListItemDto,
  UpdateDisplayScreenDto,
} from '@sewing/shared/display-screens';
import { apiFetch } from './api';

export function listDisplayScreens(): Promise<DisplayScreenListItemDto[]> {
  return apiFetch<DisplayScreenListItemDto[]>('/display-screens');
}

/**
 * Один экран для карточки `/admin/display-screens/[id]`. На 404
 * (`DISPLAY_SCREEN_NOT_FOUND`) страница отвечает `notFound()`.
 */
export function getDisplayScreen(id: string): Promise<DisplayScreenDetailDto> {
  return apiFetch<DisplayScreenDetailDto>(
    `/display-screens/${encodeURIComponent(id)}`,
  );
}

/**
 * Правка экрана: название, подразделение, логин и PIN его
 * DISPLAY-учётки (`PATCH /api/display-screens/:id`, см. `docs/api.md
 * §33`). Включение/выключение сюда не входит — это контур архива на
 * списке.
 */
export function updateDisplayScreen(
  id: string,
  body: UpdateDisplayScreenDto,
): Promise<DisplayScreenDetailDto> {
  return apiFetch<DisplayScreenDetailDto>(
    `/display-screens/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

/**
 * Создание display-экрана + DISPLAY-учётки одной транзакцией
 * (см. `docs/api.md §11`). Используется со страницы
 * `/admin/display-screens/new` через server action
 * `createDisplayScreenAction`.
 */
export function createDisplayScreen(
  body: CreateDisplayScreenDto,
): Promise<DisplayScreenDetailDto> {
  return apiFetch<DisplayScreenDetailDto>('/display-screens', {
    method: 'POST',
    body,
  });
}
