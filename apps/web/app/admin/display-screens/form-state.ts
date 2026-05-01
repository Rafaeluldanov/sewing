/**
 * Тип и initial state для формы создания display-экрана
 * (`/admin/display-screens/new`).
 *
 * Вынесено из `./actions.ts`, потому что файл с директивой
 * `'use server'` в Next.js может экспортировать только async-функции
 * (см. тот же приём в `app/admin/employees/form-state.ts`).
 */

export interface CreateDisplayScreenState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateDisplayScreenState: CreateDisplayScreenState = {};
