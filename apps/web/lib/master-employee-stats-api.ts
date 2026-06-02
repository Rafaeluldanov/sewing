/**
 * Серверные обёртки над Nest API «Статистика по сотрудникам» (кабинет
 * мастера). Контракт — `apps/api/src/modules/master-employee-stats/*`,
 * `@sewing/shared` (`master-employee-stats.ts`). Используются из server
 * actions (`apps/web/app/master/employee-stats-actions.ts`).
 */

import type {
  MasterEmployeeDrillDto,
  MasterEmployeeStatsDrillQuery,
  MasterEmployeeStatsDto,
  MasterEmployeeStatsQuery,
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
