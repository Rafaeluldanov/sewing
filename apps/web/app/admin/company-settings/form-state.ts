/**
 * Тип и initial state для форм блока «Настройки компании».
 *
 * Вынесено из `./actions.ts`, потому что файл с `'use server'` в
 * Next.js может экспортировать только async-функции (см. комментарий
 * в `app/admin/clients/form-state.ts`).
 */

export interface UpdateCompanySettingsState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateCompanySettingsState: UpdateCompanySettingsState = {};

export interface CreateCompanyDivisionState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateCompanyDivisionState: CreateCompanyDivisionState = {};

export interface UpdateCompanyDivisionState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateCompanyDivisionState: UpdateCompanyDivisionState = {};
