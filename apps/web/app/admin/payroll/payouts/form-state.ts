/**
 * Вспомогательные типы form-state для server actions модуля
 * «PayrollPayout» (PHASE 3 STEP 4).
 *
 * Вынесено из `actions.ts` в отдельный файл, чтобы client-
 * компоненты могли импортировать тип без касания серверного модуля
 * с `'use server'`.
 */

export interface PayrollPayoutActionState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}
