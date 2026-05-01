/**
 * Серверные обёртки над `/api/company-settings` и
 * `/api/company-divisions` (см.
 * `apps/api/src/modules/company-settings/*`).
 *
 * Используется из RSC `/admin/company-settings` и из server actions
 * правки реквизитов / подразделений. Контракты — те же Zod-схемы из
 * `@sewing/shared/company-settings` и `@sewing/shared/company-divisions`,
 * что валидирует backend.
 */
import type {
  CompanySettingsDto,
  UpdateCompanySettingsDto,
} from '@sewing/shared/company-settings';
import type {
  CompanyDivisionDto,
  CreateCompanyDivisionDto,
  ListCompanyDivisionsQuery,
  UpdateCompanyDivisionDto,
} from '@sewing/shared/company-divisions';
import { apiFetch } from './api';

// ---------------------------------------------------------------------------
// Company settings (singleton)
// ---------------------------------------------------------------------------

export function getCompanySettings(): Promise<CompanySettingsDto> {
  return apiFetch<CompanySettingsDto>('/company-settings', {
    cache: 'no-store',
  });
}

export function updateCompanySettings(
  body: UpdateCompanySettingsDto,
): Promise<CompanySettingsDto> {
  return apiFetch<CompanySettingsDto>('/company-settings', {
    method: 'PATCH',
    body,
  });
}

// ---------------------------------------------------------------------------
// Company divisions (CRUD soft-delete)
// ---------------------------------------------------------------------------

export function listCompanyDivisions(
  query: ListCompanyDivisionsQuery = {},
): Promise<CompanyDivisionDto[]> {
  const params = new URLSearchParams();
  if (query.includeInactive !== undefined) {
    params.set('includeInactive', String(query.includeInactive));
  }
  if (query.search) params.set('search', query.search);
  const qs = params.toString();
  const path = qs.length > 0 ? `/company-divisions?${qs}` : '/company-divisions';
  return apiFetch<CompanyDivisionDto[]>(path, { cache: 'no-store' });
}

export function getCompanyDivision(id: string): Promise<CompanyDivisionDto> {
  return apiFetch<CompanyDivisionDto>(
    `/company-divisions/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createCompanyDivision(
  body: CreateCompanyDivisionDto,
): Promise<CompanyDivisionDto> {
  return apiFetch<CompanyDivisionDto>('/company-divisions', {
    method: 'POST',
    body,
  });
}

export function updateCompanyDivision(
  id: string,
  body: UpdateCompanyDivisionDto,
): Promise<CompanyDivisionDto> {
  return apiFetch<CompanyDivisionDto>(
    `/company-divisions/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}
