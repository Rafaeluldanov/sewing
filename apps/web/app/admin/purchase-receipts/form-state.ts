/**
 * Состояния форм для блока «Приёмка поставок» (Этап 7А).
 *
 * Вынесено из `./actions.ts`, потому что файл с `'use server'` в
 * Next.js может экспортировать только async-функции (типы должны
 * жить в обычном модуле).
 */

export interface CreatePurchaseReceiptState {
  ok?: boolean;
  /**
   * Куда редиректить после успешного create. Frontend сам выполняет
   * `redirect(...)` в `useEffect`, потому что server action
   * возвращается через `useFormState` — `redirect()` в нём не
   * срабатывает.
   */
  redirectTo?: string;
  error?: string;
  errorCode?: string;
  errorRequestId?: string;
}

export const initialCreatePurchaseReceiptState: CreatePurchaseReceiptState = {};

export interface CancelPurchaseReceiptState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCancelPurchaseReceiptState: CancelPurchaseReceiptState =
  {};
