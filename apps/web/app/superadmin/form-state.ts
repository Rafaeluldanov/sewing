/**
 * Типы state для форм панели супер-админа (вынесены из `actions.ts`:
 * файл `'use server'` экспортирует только async-функции).
 */

export interface CreateTenantState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  /** Хвост лога провижининга (успех или ошибка). */
  log?: string;
}

export const initialCreateTenantState: CreateTenantState = {};

export interface AddDomainState {
  ok?: boolean;
  error?: string;
}

export const initialAddDomainState: AddDomainState = {};

export interface DeleteTenantState {
  error?: string;
  /** Хвост лога удаления (при частичном/неуспешном удалении). */
  log?: string;
}

export const initialDeleteTenantState: DeleteTenantState = {};
