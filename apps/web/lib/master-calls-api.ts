/**
 * Серверные обёртки над Nest API модуля «Мастер цеха» (MVP).
 *
 * Контракт — `apps/api/src/modules/master-calls/master-calls.controller.ts`,
 * `@sewing/shared/master-calls`. Используются из server actions
 * (`apps/web/app/master/actions.ts`) и со страниц RSC
 * (`apps/web/app/master/page.tsx`).
 */

import type {
  CreateMasterCallDto,
  MasterCallDto,
  ResolveMasterCallByQrDto,
} from '@sewing/shared/master-calls';
import { apiFetch } from './api';

export function createMasterCall(
  body: CreateMasterCallDto = {},
): Promise<MasterCallDto> {
  return apiFetch<MasterCallDto>('/master-calls', {
    method: 'POST',
    body,
  });
}

export function listOpenMasterCalls(): Promise<MasterCallDto[]> {
  return apiFetch<MasterCallDto[]>('/master-calls', { cache: 'no-store' });
}

export function resolveMasterCallByEmployeeQr(
  body: ResolveMasterCallByQrDto,
): Promise<MasterCallDto> {
  return apiFetch<MasterCallDto>('/master-calls/resolve-by-employee-qr', {
    method: 'POST',
    body,
  });
}
