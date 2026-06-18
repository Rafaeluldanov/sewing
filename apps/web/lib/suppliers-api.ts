/**
 * Серверные обёртки над `/api/suppliers/*` (см.
 * `apps/api/src/modules/suppliers/suppliers.controller.ts`).
 *
 * Используется из RSC (`/admin/suppliers/*`, селект поставщика в
 * `/admin/workshop-needs/[id]`) и из server actions создания/правки
 * карточек поставщиков, контактов и каталога. Контракты — те же
 * Zod-схемы из `@sewing/shared/suppliers`, что валидирует backend.
 */
import type {
  CreateSupplierCatalogItemDto,
  CreateSupplierContactDto,
  CreateSupplierDto,
  ListSupplierCatalogQuery,
  ListSuppliersQuery,
  SupplierCatalogItemDto,
  SupplierContactDto,
  SupplierDetailDto,
  SupplierListItemDto,
  UpdateSupplierCatalogItemDto,
  UpdateSupplierContactDto,
  UpdateSupplierDto,
} from '@sewing/shared/suppliers';
import { apiFetch } from './api';

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export function listSuppliers(
  query: ListSuppliersQuery = {},
): Promise<SupplierListItemDto[]> {
  return apiFetch<SupplierListItemDto[]>('/suppliers', {
    cache: 'no-store',
    searchParams: {
      search: query.search,
      status: query.status,
    },
  });
}

export function getSupplier(id: string): Promise<SupplierDetailDto> {
  return apiFetch<SupplierDetailDto>(`/suppliers/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
}

export function createSupplier(
  body: CreateSupplierDto,
): Promise<SupplierDetailDto> {
  return apiFetch<SupplierDetailDto>('/suppliers', { method: 'POST', body });
}

export function updateSupplier(
  id: string,
  body: UpdateSupplierDto,
): Promise<SupplierDetailDto> {
  return apiFetch<SupplierDetailDto>(`/suppliers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

/**
 * Физическое удаление поставщика (`DELETE /suppliers/:id`). Backend
 * блокирует удаление 409-кой (`SUPPLIER_HAS_PURCHASE_ORDERS`), если на
 * поставщика выписаны заказы — тогда карточку нужно архивировать.
 */
export function deleteSupplier(id: string): Promise<void> {
  return apiFetch<void>(`/suppliers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export function createSupplierContact(
  supplierId: string,
  body: CreateSupplierContactDto,
): Promise<SupplierContactDto> {
  return apiFetch<SupplierContactDto>(
    `/suppliers/${encodeURIComponent(supplierId)}/contacts`,
    { method: 'POST', body },
  );
}

export function updateSupplierContact(
  supplierId: string,
  contactId: string,
  body: UpdateSupplierContactDto,
): Promise<SupplierContactDto> {
  return apiFetch<SupplierContactDto>(
    `/suppliers/${encodeURIComponent(supplierId)}/contacts/${encodeURIComponent(contactId)}`,
    { method: 'PATCH', body },
  );
}

export function deleteSupplierContact(
  supplierId: string,
  contactId: string,
): Promise<void> {
  return apiFetch<void>(
    `/suppliers/${encodeURIComponent(supplierId)}/contacts/${encodeURIComponent(contactId)}`,
    { method: 'DELETE' },
  );
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export function listSupplierCatalog(
  supplierId: string,
  query: ListSupplierCatalogQuery = {},
): Promise<SupplierCatalogItemDto[]> {
  return apiFetch<SupplierCatalogItemDto[]>(
    `/suppliers/${encodeURIComponent(supplierId)}/catalog`,
    {
      cache: 'no-store',
      searchParams: {
        search: query.search,
        status: query.status,
      },
    },
  );
}

export function createSupplierCatalogItem(
  supplierId: string,
  body: CreateSupplierCatalogItemDto,
): Promise<SupplierCatalogItemDto> {
  return apiFetch<SupplierCatalogItemDto>(
    `/suppliers/${encodeURIComponent(supplierId)}/catalog`,
    { method: 'POST', body },
  );
}

export function updateSupplierCatalogItem(
  supplierId: string,
  itemId: string,
  body: UpdateSupplierCatalogItemDto,
): Promise<SupplierCatalogItemDto> {
  return apiFetch<SupplierCatalogItemDto>(
    `/suppliers/${encodeURIComponent(supplierId)}/catalog/${encodeURIComponent(itemId)}`,
    { method: 'PATCH', body },
  );
}

/**
 * Soft-archive позиции: backend ставит `status = INACTIVE`, физически
 * не удаляет (см. `SuppliersController.archiveCatalogItem`).
 */
export function archiveSupplierCatalogItem(
  supplierId: string,
  itemId: string,
): Promise<SupplierCatalogItemDto> {
  return apiFetch<SupplierCatalogItemDto>(
    `/suppliers/${encodeURIComponent(supplierId)}/catalog/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
  );
}
