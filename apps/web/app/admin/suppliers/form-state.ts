/**
 * Состояния форм блока «Поставщики» (Этап 5).
 *
 * Вынесено из `./actions.ts`, потому что файл с `'use server'` в
 * Next.js может экспортировать только async-функции.
 */

export interface CreateSupplierState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}
export const initialCreateSupplierState: CreateSupplierState = {};

export interface UpdateSupplierState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}
export const initialUpdateSupplierState: UpdateSupplierState = {};

export interface SupplierContactFormState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}
export const initialSupplierContactFormState: SupplierContactFormState = {};

export interface SupplierCatalogItemFormState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}
export const initialSupplierCatalogItemFormState: SupplierCatalogItemFormState =
  {};
