/**
 * Серверные обёртки над Nest API для модуля ВТО (role-terminal `/wto`).
 *
 * Все функции рассчитаны на использование из RSC / server actions —
 * полный аналог `qc-api.ts` для ОТК (см. `apps/web/lib/qc-api.ts`).
 *
 * NB. «Принять паспорт на ВТО» — это общий `POST /api/passports/:id/scan`
 * (см. `shifts-api.ts → scanOnOperation`). Backend сам делает
 * QC-gate в `PassportsService.scanOnOperation`, поэтому отдельной
 * обёртки `acceptOnWto` мы не вводим.
 */

import type { WtoPassportDetailDto } from '@sewing/shared/wto';
import { apiFetch } from './api';

export function getWtoPassport(id: string): Promise<WtoPassportDetailDto> {
  return apiFetch<WtoPassportDetailDto>(
    `/wto/passports/${encodeURIComponent(id)}`,
  );
}

/**
 * WTO role-terminal: «Завершить ВТО». Body пустой — актор берётся
 * из сессии. См. `WtoService.completeWto`.
 */
export function completeWtoPassport(
  id: string,
): Promise<WtoPassportDetailDto> {
  return apiFetch<WtoPassportDetailDto>(
    `/wto/passports/${encodeURIComponent(id)}/complete`,
    { method: 'POST', body: {} },
  );
}
