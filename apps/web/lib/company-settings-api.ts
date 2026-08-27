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
  OffRouteReadinessDto,
  TerminateSessionsResponseDto,
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

/**
 * «Завершить все сеансы»: сдвигает отсечку, после которой ранее
 * выданные session-cookie перестают пускать в систему. Выгоняет и
 * того, кто нажал кнопку, — включая эту самую вкладку.
 */
export function terminateAllSessions(): Promise<TerminateSessionsResponseDto> {
  return apiFetch<TerminateSessionsResponseDto>(
    '/company-settings/terminate-sessions',
    { method: 'POST' },
  );
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

/**
 * Готовность к включению `BLOCK` (счётчик срабатываний гейта +
 * блокеры). Отдельная ручка: read-модель поверх `AuditLog` и шаблонов
 * маршрутов, тянуть её вместе с реквизитами незачем.
 */
export function getOffRouteReadiness(): Promise<OffRouteReadinessDto> {
  return apiFetch<OffRouteReadinessDto>(
    '/company-settings/off-route-readiness',
    { cache: 'no-store' },
  );
}
