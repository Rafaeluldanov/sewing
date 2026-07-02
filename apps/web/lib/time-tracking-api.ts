/**
 * Серверная обёртка над Nest API «Тайм-трекер сотрудника». Контракт —
 * `apps/api/src/modules/time-tracking/*`, `@sewing/shared`
 * (`time-tracking.ts`). Вызывается из server-компонента вкладки
 * `apps/web/app/admin/employees/[id]/time-tracker/page.tsx`.
 */

import type {
  TimeTrackingDto,
  TimeTrackingSummaryDto,
} from '@sewing/shared';
import { apiFetch } from './api';

/** Обзор всех сотрудников за период (список-уровень вкладки). */
export function getEmployeesTimeTrackingSummary(query: {
  from: string;
  to: string;
}): Promise<TimeTrackingSummaryDto> {
  return apiFetch<TimeTrackingSummaryDto>(
    '/admin/employees/time-tracker-summary',
    {
      cache: 'no-store',
      searchParams: { from: query.from, to: query.to },
    },
  );
}

/** Провал в одного сотрудника — таймлайн сеансов за период. */
export function getEmployeeTimeTracking(
  employeeId: string,
  query: { from: string; to: string },
): Promise<TimeTrackingDto> {
  return apiFetch<TimeTrackingDto>(
    `/admin/employees/${employeeId}/time-tracking`,
    {
      cache: 'no-store',
      searchParams: { from: query.from, to: query.to },
    },
  );
}
