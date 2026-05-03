/**
 * Серверные обёртки над `/api/payroll/*` (PHASE 1 read-only,
 * см. `docs/api.md §10c`, `docs/screens.md §12a`).
 *
 * Используются только из RSC `/admin/payroll/*` под ролями
 * `SHOP_MANAGER` / `ADMIN`. Backend в любом случае закрывает
 * остальные роли 403 (см. `apps/api/src/modules/payroll/payroll.controller.ts`),
 * но guard в `app/admin/layout.tsx` режет всех не-менеджеров ещё
 * до сетевого round-trip.
 *
 * Все три ручки read-only — никаких POST/PATCH здесь не появится в
 * PHASE 1: payroll API сознательно ничего не пишет, он только
 * агрегирует уже существующие `OperationEntry` / `SalaryEntry` /
 * `ShiftSession`.
 */
import type {
  PayrollDailyPageDto,
  PayrollDailyQuery,
  PayrollDebtsPageDto,
  PayrollDebtsQuery,
  PayrollEmployeeDetailDto,
  PayrollEmployeeQuery,
  PayrollPeriodPageDto,
  PayrollPeriodQuery,
} from '@sewing/shared/payroll';
import { apiFetch } from './api';

export function getPayrollPeriod(
  query: Partial<PayrollPeriodQuery>,
): Promise<PayrollPeriodPageDto> {
  return apiFetch<PayrollPeriodPageDto>('/payroll/period', {
    searchParams: {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      employeeId: query.employeeId,
      role: query.role,
      divisionCode: query.divisionCode,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    },
  });
}

export function getPayrollDaily(
  query: Partial<PayrollDailyQuery>,
): Promise<PayrollDailyPageDto> {
  return apiFetch<PayrollDailyPageDto>('/payroll/daily', {
    searchParams: {
      date: query.date,
      role: query.role,
      divisionCode: query.divisionCode,
    },
  });
}

export function getPayrollDebts(
  query: Partial<PayrollDebtsQuery>,
): Promise<PayrollDebtsPageDto> {
  return apiFetch<PayrollDebtsPageDto>('/payroll/debts', {
    searchParams: {
      asOfDate: query.asOfDate,
      employeeId: query.employeeId,
      role: query.role,
      divisionCode: query.divisionCode,
      page: query.page,
      pageSize: query.pageSize,
    },
  });
}

export function getPayrollEmployee(
  employeeId: string,
  query: Partial<PayrollEmployeeQuery>,
): Promise<PayrollEmployeeDetailDto> {
  return apiFetch<PayrollEmployeeDetailDto>(
    `/payroll/employees/${encodeURIComponent(employeeId)}`,
    {
      searchParams: {
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
      },
    },
  );
}
