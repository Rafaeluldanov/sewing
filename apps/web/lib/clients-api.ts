/**
 * Серверные обёртки над `/api/clients` (см.
 * `apps/api/src/modules/clients/clients.controller.ts`).
 *
 * Используется из RSC (`/admin/clients/*`, `/admin/orders/new` для
 * селекта клиента) и из server actions создания/правки карточки
 * клиента (`apps/web/app/admin/clients/actions.ts`). Контракты — те
 * же Zod-схемы из `@sewing/shared/clients`, что валидирует backend.
 */
import type {
  ClientDto,
  CreateClientDto,
  ListClientsQuery,
  UpdateClientDto,
} from '@sewing/shared/clients';
import { apiFetch } from './api';

export function listClients(
  query: ListClientsQuery = {},
): Promise<ClientDto[]> {
  const params = new URLSearchParams();
  if (query.includeInactive !== undefined) {
    params.set('includeInactive', String(query.includeInactive));
  }
  if (query.search) params.set('search', query.search);
  const qs = params.toString();
  const path = qs.length > 0 ? `/clients?${qs}` : '/clients';
  return apiFetch<ClientDto[]>(path, { cache: 'no-store' });
}

export function getClient(id: string): Promise<ClientDto> {
  return apiFetch<ClientDto>(`/clients/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
}

export function createClient(body: CreateClientDto): Promise<ClientDto> {
  return apiFetch<ClientDto>('/clients', {
    method: 'POST',
    body,
  });
}

export function updateClient(
  id: string,
  body: UpdateClientDto,
): Promise<ClientDto> {
  return apiFetch<ClientDto>(`/clients/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}
