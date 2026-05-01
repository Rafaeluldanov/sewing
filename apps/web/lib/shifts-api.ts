/**
 * Серверные обёртки над Nest API для модуля смен и выдачи кроя.
 *
 * Рассчитаны на использование из RSC / server actions. Клиентские
 * компоненты ходят сюда через server actions в `app/work/actions.ts`.
 *
 * С MVP 1.1 (ADR-0014) `employeeId` нигде явно не передаётся —
 * сервер берёт владельца действия из session-cookie.
 */

import type {
  CurrentWorkPassportDto,
  ShiftMetaDto,
  ShiftSessionDto,
  StartShiftDto,
} from '@sewing/shared/shifts';
import type { PassportDetailDto } from '@sewing/shared/passports';
import { apiFetch } from './api';

export function getShiftMeta(): Promise<ShiftMetaDto> {
  return apiFetch<ShiftMetaDto>('/shifts/meta', { cache: 'no-store' });
}

export function getCurrentShift(): Promise<ShiftSessionDto | null> {
  return apiFetch<ShiftSessionDto | null>('/shifts/current');
}

/**
 * Активные кройи, закреплённые за текущим сотрудником прямо сейчас.
 * Backend сам вырезает по сессии — никаких employeeId-параметров.
 * Используется на `/work` для блока «Текущий крой».
 */
export function getCurrentWork(): Promise<CurrentWorkPassportDto[]> {
  return apiFetch<CurrentWorkPassportDto[]>('/shifts/current-work');
}

export function startShift(body: StartShiftDto): Promise<ShiftSessionDto> {
  return apiFetch<ShiftSessionDto>('/shifts/start', {
    method: 'POST',
    body,
  });
}

export function stopShift(): Promise<ShiftSessionDto> {
  return apiFetch<ShiftSessionDto>('/shifts/stop', {
    method: 'POST',
    body: {},
  });
}

export function findPassportByCode(code: string): Promise<PassportDetailDto> {
  return apiFetch<PassportDetailDto>('/passports/by-code', {
    method: 'POST',
    body: { code },
  });
}

export function issuePassport(id: string): Promise<PassportDetailDto> {
  return apiFetch<PassportDetailDto>(
    `/passports/${encodeURIComponent(id)}/issue`,
    { method: 'POST', body: {} },
  );
}

export function scanPassport(id: string): Promise<PassportDetailDto> {
  return apiFetch<PassportDetailDto>(
    `/passports/${encodeURIComponent(id)}/scan`,
    { method: 'POST', body: {} },
  );
}

/**
 * Завершение операции швеёй (ТЗ §2, ADR-0014). На backend проверяется
 * `passport.currentEmployeeId = me AND status = IN_PROGRESS` — здесь
 * мы просто транслируем результат.
 */
export function completePassportOperation(id: string): Promise<PassportDetailDto> {
  return apiFetch<PassportDetailDto>(
    `/passports/${encodeURIComponent(id)}/complete-operation`,
    { method: 'POST', body: {} },
  );
}
