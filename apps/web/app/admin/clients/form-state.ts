/**
 * Тип и initial state для форм блока «Клиенты».
 *
 * Вынесено из `./actions.ts`, потому что файл с `'use server'` в
 * Next.js может экспортировать только async-функции (см. комментарий
 * в `app/admin/employees/form-state.ts`).
 */

export interface CreateClientState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateClientState: CreateClientState = {};

export interface UpdateClientState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateClientState: UpdateClientState = {};
