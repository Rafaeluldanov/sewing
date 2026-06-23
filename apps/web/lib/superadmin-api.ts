/**
 * Серверные обёртки API панели супер-админа control-plane (`/api/superadmin/*`).
 * Только для RSC/server-actions раздела `/superadmin`.
 */
import type {
  AddDomainDto,
  CreateTenantDto,
  CreateTenantResultDto,
  SetModuleDto,
  SetStatusDto,
  TenantSummaryDto,
} from '@sewing/shared/superadmin';
import { apiFetch } from './api';

export function listTenants(): Promise<TenantSummaryDto[]> {
  return apiFetch<TenantSummaryDto[]>('/superadmin/tenants', {
    cache: 'no-store',
  });
}

export function getTenant(id: string): Promise<TenantSummaryDto> {
  return apiFetch<TenantSummaryDto>(
    `/superadmin/tenants/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createTenant(
  body: CreateTenantDto,
): Promise<CreateTenantResultDto> {
  return apiFetch<CreateTenantResultDto>('/superadmin/tenants', {
    method: 'POST',
    body,
  });
}

export function setTenantModule(
  id: string,
  body: SetModuleDto,
): Promise<TenantSummaryDto> {
  return apiFetch<TenantSummaryDto>(
    `/superadmin/tenants/${encodeURIComponent(id)}/modules`,
    { method: 'POST', body },
  );
}

export function setTenantStatus(
  id: string,
  body: SetStatusDto,
): Promise<TenantSummaryDto> {
  return apiFetch<TenantSummaryDto>(
    `/superadmin/tenants/${encodeURIComponent(id)}/status`,
    { method: 'POST', body },
  );
}

export function addTenantDomain(
  id: string,
  body: AddDomainDto,
): Promise<TenantSummaryDto> {
  return apiFetch<TenantSummaryDto>(
    `/superadmin/tenants/${encodeURIComponent(id)}/domains`,
    { method: 'POST', body },
  );
}

export function removeTenantDomain(
  id: string,
  domainId: string,
): Promise<TenantSummaryDto> {
  return apiFetch<TenantSummaryDto>(
    `/superadmin/tenants/${encodeURIComponent(id)}/domains/${encodeURIComponent(domainId)}`,
    { method: 'DELETE' },
  );
}
