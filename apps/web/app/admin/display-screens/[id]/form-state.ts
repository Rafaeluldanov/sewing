/**
 * Типы и initial state форм карточки display-экрана
 * (`/admin/display-screens/[id]`).
 *
 * Вынесено из `./actions.ts`, потому что файл с директивой
 * `'use server'` в Next.js может экспортировать ТОЛЬКО async-функции:
 * `export const initialXxx` там роняет всю страницу в рантайме, и ни
 * tsc, ни lint, ни build об этом не предупреждают (тот же приём, что в
 * `app/admin/display-screens/form-state.ts`).
 */

/** Состояние формы «Основное» (название / подразделение / логин). */
export interface UpdateDisplayScreenState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateDisplayScreenState: UpdateDisplayScreenState = {};

/** Состояние отдельной формы смены PIN'а монитора. */
export interface UpdateDisplayPinState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateDisplayPinState: UpdateDisplayPinState = {};
