/**
 * Серверная обёртка над Nest API «Тайм-трекер сотрудника». Контракт —
 * `apps/api/src/modules/time-tracking/*`, `@sewing/shared`
 * (`time-tracking.ts`). Вызывается из server-компонента вкладки
 * `apps/web/app/admin/employees/[id]/time-tracker/page.tsx`.
 */

import type { TimeTrackingDto } from '@sewing/shared';
import { apiFetch } from './api';

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
