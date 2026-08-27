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

/**
 * State inline-формы «Настройки материалов и склада по подразделениям»
 * (см. `material-stock-division-overrides-section.tsx`). Отдельный
 * тип, чтобы успех/ошибка одной строки не перезаписывали общий
 * feedback правки реквизитов.
 */
export interface UpdateCompanyDivisionOverridesState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateCompanyDivisionOverridesState: UpdateCompanyDivisionOverridesState =
  {};

/** State секции «Работа мимо маршрута» (строгость гейта). */
export interface UpdateOffRoutePolicyState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateOffRoutePolicyState: UpdateOffRoutePolicyState = {};

/**
 * State секции «Вход и сессии»: окно автовыхода по бездействию и
 * кнопка «Завершить все сеансы». Один тип на обе формы секции —
 * успех/ошибка у них не пересекаются во времени (сохранение окна и
 * разовое действие).
 */
export interface UpdateSessionPolicyState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateSessionPolicyState: UpdateSessionPolicyState = {};
