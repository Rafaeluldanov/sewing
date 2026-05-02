/**
 * Серверные обёртки над `/api/payroll-payouts/*` (PHASE 3 STEP 4).
 *
 * Используются только из RSC `/admin/payroll/payouts/*` под ролями
 * `SHOP_MANAGER` / `ADMIN`. Backend защищает эндпоинты через
 * `@Roles('SHOP_MANAGER', 'ADMIN')`.
 *
 * ACK (подтверждение получения) намеренно не включён — это действие
 * сотрудника (PHASE 3 STEP 5, `/earnings/payouts`).
 */
import type {
  CancelPayrollPayoutDto,
  CreatePayrollPayoutDto,
  PayrollPayoutDto,
  PayrollPayoutListQuery,
  PayrollPayoutPageDto,
  RecomputePayrollPayoutDto,
} from '@sewing/shared/payroll-payouts';
import { apiFetch } from './api';

export function listPayrollPayouts(
  query: Partial<PayrollPayoutListQuery> = {},
): Promise<PayrollPayoutPageDto> {
  return apiFetch<PayrollPayoutPageDto>('/payroll-payouts', {
    searchParams: {
      employeeId: query.employeeId,
      status: query.status,
      periodFrom: query.periodFrom,
      periodTo: query.periodTo,
      page: query.page,
      pageSize: query.pageSize,
    },
  });
}

export function getPayrollPayout(id: string): Promise<PayrollPayoutDto> {
  return apiFetch<PayrollPayoutDto>(
    `/payroll-payouts/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createPayrollPayout(
  dto: CreatePayrollPayoutDto,
): Promise<PayrollPayoutDto> {
  return apiFetch<PayrollPayoutDto>('/payroll-payouts', {
    method: 'POST',
    body: dto,
  });
}

export function recomputePayrollPayout(
  id: string,
  dto: RecomputePayrollPayoutDto = {},
): Promise<PayrollPayoutDto> {
  return apiFetch<PayrollPayoutDto>(
    `/payroll-payouts/${encodeURIComponent(id)}/recompute`,
    { method: 'POST', body: dto },
  );
}

export function issuePayrollPayout(id: string): Promise<PayrollPayoutDto> {
  return apiFetch<PayrollPayoutDto>(
    `/payroll-payouts/${encodeURIComponent(id)}/issue`,
    { method: 'POST', body: {} },
  );
}

export function cancelPayrollPayout(
  id: string,
  dto: CancelPayrollPayoutDto = {},
): Promise<PayrollPayoutDto> {
  return apiFetch<PayrollPayoutDto>(
    `/payroll-payouts/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body: dto },
  );
}
