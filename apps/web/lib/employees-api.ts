/**
 * Серверные обёртки над Nest API блока «Сотрудники» (post-Шаг 18 /
 * Шаг 19, ADR-0021). См. контракты `docs/api.md §10b`.
 *
 * Используются из RSC `/admin/employees` и server actions
 * редактирования карточки сотрудника.
 */

import type {
  CreateEmployeeDto,
  EmployeeDetailDto,
  EmployeeListItemDto,
  ListEmployeesQuery,
  UpdateEmployeeDto,
} from '@sewing/shared/employees';
import { apiFetch } from './api';

export const COMPENSATION_LABELS: Record<
  EmployeeListItemDto['compensationType'],
  string
> = {
  PIECEWORK: 'Сдельная',
  SALARY: 'Оклад за смену',
  MIXED: 'Оклад + сдельная',
};

export function listEmployees(
  query: Partial<ListEmployeesQuery> = {},
): Promise<EmployeeListItemDto[]> {
  return apiFetch<EmployeeListItemDto[]>('/employees', {
    searchParams: {
      active:
        query.active === undefined
          ? undefined
          : query.active
          ? 'true'
          : 'false',
      role: query.role,
      compensationType: query.compensationType,
      search: query.search,
    },
  });
}

export function getEmployee(id: string): Promise<EmployeeDetailDto> {
  return apiFetch<EmployeeDetailDto>(`/employees/${encodeURIComponent(id)}`);
}

export function updateEmployee(
  id: string,
  body: UpdateEmployeeDto,
): Promise<EmployeeDetailDto> {
  return apiFetch<EmployeeDetailDto>(`/employees/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

/**
 * Создание новой карточки сотрудника (роли `ADMIN`/`SHOP_MANAGER`,
 * см. `docs/api.md §3b`). Используется со страницы
 * `/admin/employees/new` через server action `createEmployeeAction`.
 */
export function createEmployee(
  body: CreateEmployeeDto,
): Promise<EmployeeDetailDto> {
  return apiFetch<EmployeeDetailDto>('/employees', {
    method: 'POST',
    body,
  });
}
