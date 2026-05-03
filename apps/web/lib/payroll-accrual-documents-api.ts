/**
 * Серверные обёртки над `/api/payroll/accrual-documents/*` (PHASE 3 STEP 6.3).
 *
 * Функции используются из RSC `/admin/payroll/accrual-documents/*`
 * под ролями `SHOP_MANAGER` / `ADMIN`.
 */
import type {
  CancelPayrollAccrualDocumentDto,
  CreatePayrollAccrualDocumentDto,
  PayrollAccrualDocumentDto,
  PayrollAccrualDocumentListQuery,
  PayrollAccrualDocumentPageDto,
  UpdatePayrollAccrualDocumentLineDto,
} from '@sewing/shared/payroll-accrual-documents';
import { apiFetch } from './api';

export function listPayrollAccrualDocuments(
  query: Partial<PayrollAccrualDocumentListQuery> = {},
): Promise<PayrollAccrualDocumentPageDto> {
  return apiFetch<PayrollAccrualDocumentPageDto>('/payroll/accrual-documents', {
    searchParams: {
      status: query.status,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      page: query.page,
      pageSize: query.pageSize,
    },
  });
}

export function createPayrollAccrualDocument(
  dto: CreatePayrollAccrualDocumentDto,
): Promise<PayrollAccrualDocumentDto> {
  return apiFetch<PayrollAccrualDocumentDto>('/payroll/accrual-documents', {
    method: 'POST',
    body: dto,
  });
}

export function getPayrollAccrualDocument(
  id: string,
): Promise<PayrollAccrualDocumentDto> {
  return apiFetch<PayrollAccrualDocumentDto>(
    `/payroll/accrual-documents/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function recomputePayrollAccrualDocument(
  id: string,
): Promise<PayrollAccrualDocumentDto> {
  return apiFetch<PayrollAccrualDocumentDto>(
    `/payroll/accrual-documents/${encodeURIComponent(id)}/recompute`,
    { method: 'POST', body: {} },
  );
}

export function updatePayrollAccrualDocumentLine(
  documentId: string,
  lineId: string,
  dto: UpdatePayrollAccrualDocumentLineDto,
): Promise<PayrollAccrualDocumentDto> {
  return apiFetch<PayrollAccrualDocumentDto>(
    `/payroll/accrual-documents/${encodeURIComponent(documentId)}/lines/${encodeURIComponent(lineId)}`,
    { method: 'PATCH', body: dto },
  );
}

export function payPayrollAccrualDocument(
  id: string,
): Promise<PayrollAccrualDocumentDto> {
  return apiFetch<PayrollAccrualDocumentDto>(
    `/payroll/accrual-documents/${encodeURIComponent(id)}/pay`,
    { method: 'POST', body: {} },
  );
}

export function cancelPayrollAccrualDocument(
  id: string,
  dto: CancelPayrollAccrualDocumentDto = {},
): Promise<PayrollAccrualDocumentDto> {
  return apiFetch<PayrollAccrualDocumentDto>(
    `/payroll/accrual-documents/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body: dto },
  );
}
