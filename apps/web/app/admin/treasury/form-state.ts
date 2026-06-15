/**
 * Состояния форм раздела «Казначейство» (Фаза 0 — журнал ДС).
 *
 * Вынесено из `./actions.ts`: файл с `'use server'` может
 * экспортировать только async-функции.
 */

export interface TreasuryFormState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialTreasuryFormState: TreasuryFormState = {};
