/**
 * Серверные обёртки над «моими участками» (`/api/me/workplaces`,
 * `/api/me/switch-workplace` — см. `packages/shared/src/workplace.ts`).
 * Клиент ходит сюда через server-action (`switchWorkplaceAction`), а не
 * напрямую: session-cookie HttpOnly и API на другом хосте (см.
 * `lib/api.ts`).
 */

import type {
  MyWorkplacesDto,
  SwitchWorkplaceDto,
  SwitchWorkplaceResultDto,
} from '@sewing/shared/workplace';
import { apiFetch } from './api';

export function switchWorkplace(
  body: SwitchWorkplaceDto,
): Promise<SwitchWorkplaceResultDto> {
  return apiFetch<SwitchWorkplaceResultDto>('/me/switch-workplace', {
    method: 'POST',
    body,
  });
}

/** Участки сотрудника для шторки «Сменить участок». */
export function listMyWorkplaces(): Promise<MyWorkplacesDto> {
  return apiFetch<MyWorkplacesDto>('/me/workplaces');
}
