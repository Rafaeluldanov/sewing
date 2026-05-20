/**
 * Серверные обёртки над Nest API блока «Сотрудники» (post-Шаг 18 /
 * Шаг 19, ADR-0021). См. контракты `docs/api.md §10b`.
 *
 * Используются из RSC `/admin/employees` и server actions
 * редактирования карточки сотрудника.
 */

import type {
  ActiveCutterListItemDto,
  CreateEmployeeDto,
  EmployeeBlockersResponse,
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
      // PHASE 2 STEP 2: filter by company division (для payroll-фильтра
      // и для select-ов на формах выпуска паспорта/смены).
      companyDivisionId: query.companyDivisionId,
    },
  });
}

/**
 * Узкий справочник активных раскройщиков для select-а на форме
 * выпуска паспорта (`apps/web/app/orders/[id]/passports/new`).
 *
 * В отличие от `listEmployees(...)` этот endpoint:
 *   - доступен `CUTTER_ASSISTANT` (а не только `SHOP_MANAGER, ADMIN`);
 *   - возвращает только `{ id, fullName, login }` — никаких
 *     payroll-полей.
 *
 * См. `docs/cutter-assistant-passport-release-recon.md §5`.
 */
export function listActiveCutters(): Promise<ActiveCutterListItemDto[]> {
  return apiFetch<ActiveCutterListItemDto[]>('/employees/cutters');
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

/**
 * Preflight для блока archive / hard-delete (см.
 * `docs/employee-deletion-recon.md`). Используется RSC-страницей
 * `/admin/employees/[id]` для отрисовки блока «Опасная зона» и в
 * server actions для двойной проверки перед DELETE.
 */
export function getEmployeeBlockers(
  id: string,
): Promise<EmployeeBlockersResponse> {
  return apiFetch<EmployeeBlockersResponse>(
    `/employees/${encodeURIComponent(id)}/blockers`,
  );
}

/**
 * Мягкое архивирование. Идемпотентно. Возвращает обновлённый DTO.
 * 409 (`EMPLOYEE_ARCHIVE_BLOCKED`) — у сотрудника открытая активность.
 */
export function archiveEmployee(id: string): Promise<EmployeeDetailDto> {
  return apiFetch<EmployeeDetailDto>(
    `/employees/${encodeURIComponent(id)}/archive`,
    { method: 'POST', body: {} },
  );
}

/**
 * Снять архив. Идемпотентно. 409 (`EMPLOYEE_LOGIN_TAKEN`) — конфликт
 * по `Employee.login` (теоретически возможен, см. recon §3.3).
 */
export function restoreEmployee(id: string): Promise<EmployeeDetailDto> {
  return apiFetch<EmployeeDetailDto>(
    `/employees/${encodeURIComponent(id)}/restore`,
    { method: 'POST', body: {} },
  );
}

/**
 * Физическое удаление (`ADMIN` only). 409 (`EMPLOYEE_HAS_HISTORY`)
 * если есть финансовая/производственная история. 409
 * (`EMPLOYEE_DISPLAY_CASCADE_ACK_REQUIRED`) — для DISPLAY-учётки
 * с привязанным экраном требуется явный `ackDisplayCascade=true`.
 */
export function deleteEmployee(
  id: string,
  opts: { ackDisplayCascade?: boolean } = {},
): Promise<void> {
  return apiFetch<void>(`/employees/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    searchParams: opts.ackDisplayCascade
      ? { ackDisplayCascade: 'true' }
      : undefined,
  });
}
