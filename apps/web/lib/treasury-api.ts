/**
 * Серверные обёртки над `/api/treasury/*` (см.
 * `apps/api/src/modules/treasury/treasury.controller.ts`).
 *
 * Используется из RSC (`/admin/treasury/*`) и server actions. Контракты —
 * те же Zod-схемы из `@sewing/shared/treasury`, что валидирует backend.
 * Казначейство, Фаза 0 — журнал движения ДС (касса + расчётный счёт).
 */
import type {
  CashAccountDto,
  CashFlowItemDto,
  CashFlowEntryDto,
  TreasuryBalancesDto,
  CreateCashAccountDto,
  UpdateCashAccountDto,
  ListCashAccountsQuery,
  CreateCashFlowItemDto,
  UpdateCashFlowItemDto,
  ListCashFlowItemsQuery,
  CreateCashFlowEntryDto,
  StornoCashFlowEntryDto,
  ListCashFlowEntriesQuery,
  SupplierPaymentDto,
  CreateSupplierPaymentDto,
  CancelSupplierPaymentDto,
  ListSupplierPaymentsQuery,
  TreasurySettingsDto,
  UpdateTreasurySettingsDto,
} from '@sewing/shared/treasury';
import { apiFetch } from './api';

// --- Счета -----------------------------------------------------------------

export function listCashAccounts(
  query: ListCashAccountsQuery = {},
): Promise<CashAccountDto[]> {
  return apiFetch<CashAccountDto[]>('/treasury/accounts', {
    cache: 'no-store',
    searchParams: {
      kind: query.kind,
      activeOnly: query.activeOnly ? '1' : undefined,
    },
  });
}

export function createCashAccount(
  body: CreateCashAccountDto,
): Promise<CashAccountDto> {
  return apiFetch<CashAccountDto>('/treasury/accounts', {
    method: 'POST',
    body,
  });
}

export function updateCashAccount(
  id: string,
  body: UpdateCashAccountDto,
): Promise<CashAccountDto> {
  return apiFetch<CashAccountDto>(
    `/treasury/accounts/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

// --- Статьи ДДС ------------------------------------------------------------

export function listCashFlowItems(
  query: ListCashFlowItemsQuery = {},
): Promise<CashFlowItemDto[]> {
  return apiFetch<CashFlowItemDto[]>('/treasury/items', {
    cache: 'no-store',
    searchParams: {
      direction: query.direction,
      activeOnly: query.activeOnly ? '1' : undefined,
    },
  });
}

export function createCashFlowItem(
  body: CreateCashFlowItemDto,
): Promise<CashFlowItemDto> {
  return apiFetch<CashFlowItemDto>('/treasury/items', {
    method: 'POST',
    body,
  });
}

export function updateCashFlowItem(
  id: string,
  body: UpdateCashFlowItemDto,
): Promise<CashFlowItemDto> {
  return apiFetch<CashFlowItemDto>(
    `/treasury/items/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

// --- Проводки журнала ------------------------------------------------------

export function listCashFlowEntries(
  query: ListCashFlowEntriesQuery = {},
): Promise<CashFlowEntryDto[]> {
  return apiFetch<CashFlowEntryDto[]>('/treasury/entries', {
    cache: 'no-store',
    searchParams: {
      accountId: query.accountId,
      itemId: query.itemId,
      direction: query.direction,
      source: query.source,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      includeStorno:
        query.includeStorno === undefined
          ? undefined
          : query.includeStorno
            ? '1'
            : '0',
      limit: query.limit?.toString(),
    },
  });
}

export function createCashFlowEntry(
  body: CreateCashFlowEntryDto,
): Promise<CashFlowEntryDto> {
  return apiFetch<CashFlowEntryDto>('/treasury/entries', {
    method: 'POST',
    body,
  });
}

export function stornoCashFlowEntry(
  id: string,
  body: StornoCashFlowEntryDto,
): Promise<CashFlowEntryDto> {
  return apiFetch<CashFlowEntryDto>(
    `/treasury/entries/${encodeURIComponent(id)}/storno`,
    { method: 'POST', body },
  );
}

// --- Остатки ---------------------------------------------------------------

export function getTreasuryBalances(): Promise<TreasuryBalancesDto> {
  return apiFetch<TreasuryBalancesDto>('/treasury/balances', {
    cache: 'no-store',
  });
}

// --- Оплаты поставщикам (Фаза 1) -------------------------------------------

export function listSupplierPayments(
  query: ListSupplierPaymentsQuery = {},
): Promise<SupplierPaymentDto[]> {
  return apiFetch<SupplierPaymentDto[]>('/treasury/supplier-payments', {
    cache: 'no-store',
    searchParams: {
      status: query.status,
      supplierId: query.supplierId,
      limit: query.limit?.toString(),
    },
  });
}

export function createSupplierPayment(
  body: CreateSupplierPaymentDto,
): Promise<SupplierPaymentDto> {
  return apiFetch<SupplierPaymentDto>('/treasury/supplier-payments', {
    method: 'POST',
    body,
  });
}

export function approveSupplierPayment(
  id: string,
): Promise<SupplierPaymentDto> {
  return apiFetch<SupplierPaymentDto>(
    `/treasury/supplier-payments/${encodeURIComponent(id)}/approve`,
    { method: 'POST' },
  );
}

export function paySupplierPayment(id: string): Promise<SupplierPaymentDto> {
  return apiFetch<SupplierPaymentDto>(
    `/treasury/supplier-payments/${encodeURIComponent(id)}/pay`,
    { method: 'POST' },
  );
}

export function cancelSupplierPayment(
  id: string,
  body: CancelSupplierPaymentDto = {},
): Promise<SupplierPaymentDto> {
  return apiFetch<SupplierPaymentDto>(
    `/treasury/supplier-payments/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body },
  );
}

// --- Настройки модуля (Фаза 1) ---------------------------------------------

export function getTreasurySettings(): Promise<TreasurySettingsDto> {
  return apiFetch<TreasurySettingsDto>('/treasury/settings', {
    cache: 'no-store',
  });
}

export function updateTreasurySettings(
  body: UpdateTreasurySettingsDto,
): Promise<TreasurySettingsDto> {
  return apiFetch<TreasurySettingsDto>('/treasury/settings', {
    method: 'PUT',
    body,
  });
}
