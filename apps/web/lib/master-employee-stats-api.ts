/**
 * Серверные обёртки над Nest API «Статистика по сотрудникам» (кабинет
 * мастера). Контракт — `apps/api/src/modules/master-employee-stats/*`,
 * `@sewing/shared` (`master-employee-stats.ts`). Используются из server
 * actions (`apps/web/app/master/employee-stats-actions.ts`).
 */

import type {
  MasterActiveShiftsDto,
  MasterCloseShiftResultDto,
  MasterEmployeeAccessDto,
  MasterEmployeeAccessListDto,
  MasterEmployeeDrillDto,
  MasterEmployeeStatsDrillQuery,
  MasterEmployeeStatsDto,
  MasterEmployeeStatsQuery,
  MasterUpdateEmployeeAccessDto,
} from '@sewing/shared';
import { apiFetch } from './api';

export function getMasterEmployeeStats(
  query: MasterEmployeeStatsQuery,
): Promise<MasterEmployeeStatsDto> {
  return apiFetch<MasterEmployeeStatsDto>('/master/employee-stats', {
    cache: 'no-store',
    searchParams: { from: query.from, to: query.to },
  });
}

export function getMasterEmployeeStatsDrill(
  query: MasterEmployeeStatsDrillQuery,
): Promise<MasterEmployeeDrillDto> {
  return apiFetch<MasterEmployeeDrillDto>('/master/employee-stats/drill', {
    cache: 'no-store',
    searchParams: {
      from: query.from,
      to: query.to,
      employeeId: query.employeeId,
    },
  });
}

/** Режим «Активные»: открытые смены прямо сейчас, `startedAt` ASC. */
export function getMasterActiveShifts(): Promise<MasterActiveShiftsDto> {
  return apiFetch<MasterActiveShiftsDto>(
    '/master/employee-stats/active-shifts',
    { cache: 'no-store' },
  );
}

/**
 * Принудительное завершение смены мастером. Без `force` при паспортах
 * на руках API отвечает `409 SHIFT_HAS_ACTIVE_PASSPORTS` — UI
 * показывает подтверждение и повторяет с `force: true`.
 */
export function closeMasterActiveShift(
  shiftId: string,
  body: { force: boolean },
): Promise<MasterCloseShiftResultDto> {
  return apiFetch<MasterCloseShiftResultDto>(
    `/master/employee-stats/active-shifts/${encodeURIComponent(shiftId)}/close`,
    { method: 'POST', body },
  );
}

/** Режим «Доступы»: активные сотрудники и их участки. */
export function getMasterEmployeeAccess(): Promise<MasterEmployeeAccessListDto> {
  return apiFetch<MasterEmployeeAccessListDto>('/master/employee-stats/access', {
    cache: 'no-store',
  });
}

/**
 * Мастер меняет набор участков сотрудника. Белый список цеховых ролей
 * проверяет сервер — UI лишь не показывает лишние чипы.
 */
export function updateMasterEmployeeAccess(
  employeeId: string,
  body: MasterUpdateEmployeeAccessDto,
): Promise<MasterEmployeeAccessDto> {
  return apiFetch<MasterEmployeeAccessDto>(
    `/master/employee-stats/access/${encodeURIComponent(employeeId)}`,
    { method: 'PUT', body },
  );
}
