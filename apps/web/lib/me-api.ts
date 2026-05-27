/**
 * Серверные обёртки над `GET /api/me/daily` и `GET /api/me/history`.
 *
 * Источник истины контракта — `apps/api/src/modules/me/me.controller.ts`,
 * `packages/shared/src/me-daily.ts`. Используются из server-action'ов
 * (`apps/web/app/me/actions.ts`), которые дёргает клиентский
 * `DailyEarningsChip` (`apps/web/components/me/daily-earnings-chip.tsx`).
 *
 * Клиент напрямую fetch'ить не может: session-cookie HttpOnly, и API
 * живёт на другом хосте — см. `lib/api.ts`.
 */

import type { MeDailyDto, MeHistoryDto } from '@sewing/shared/me-daily';
import { apiFetch } from './api';

export function getMyDaily(): Promise<MeDailyDto> {
  return apiFetch<MeDailyDto>('/me/daily');
}

export function getMyHistory(days = 30): Promise<MeHistoryDto> {
  return apiFetch<MeHistoryDto>(`/me/history?days=${days}`);
}
