/**
 * Серверная обёртка над `POST /api/me/switch-workplace` (фича «смена
 * роли сканом рабочего места», см. `packages/shared/src/workplace.ts`).
 * Клиент ходит сюда через server-action (`switchWorkplaceAction`), а не
 * напрямую: session-cookie HttpOnly и API на другом хосте (см.
 * `lib/api.ts`).
 */

import type {
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
