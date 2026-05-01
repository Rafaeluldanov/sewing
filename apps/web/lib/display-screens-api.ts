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
} from '@sewing/shared/display-screens';
import { apiFetch } from './api';

export function listDisplayScreens(): Promise<DisplayScreenListItemDto[]> {
  return apiFetch<DisplayScreenListItemDto[]>('/display-screens');
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
