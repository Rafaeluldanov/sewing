/**
 * Состояния форм для блока «Заказы поставщикам» (Этап 6А).
 *
 * Вынесено из `./actions.ts`, потому что файл с `'use server'` в
 * Next.js может экспортировать только async-функции (типы должны
 * жить в обычном модуле).
 */

export interface CreatePurchaseOrderFromNeedsState {
  ok?: boolean;
  /**
   * Куда редиректить после успешного create (см.
   * `createPurchaseOrderFromNeedsAction`). Frontend сам выполняет
   * `redirect(...)` в `useEffect`, потому что server action
   * возвращается через `useFormState` — `redirect()` в нём не
   * срабатывает.
   */
  redirectTo?: string;
  error?: string;
  errorCode?: string;
  errorRequestId?: string;
}

export const initialCreatePurchaseOrderFromNeedsState: CreatePurchaseOrderFromNeedsState =
  {};

export interface UpdatePurchaseOrderState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdatePurchaseOrderState: UpdatePurchaseOrderState = {};

export interface UpdatePurchaseOrderLineState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdatePurchaseOrderLineState: UpdatePurchaseOrderLineState =
  {};

export interface PurchaseOrderActionState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialPurchaseOrderActionState: PurchaseOrderActionState = {};
