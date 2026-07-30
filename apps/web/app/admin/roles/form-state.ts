/**
 * Состояние форм раздела «Роли».
 *
 * Отдельным файлом, потому что `actions.ts` помечен `'use server'`, а
 * такой модуль может экспортировать ТОЛЬКО async-функции: любой
 * `export const initialXxx` роняет страницу в рантайме (tsc и билд при
 * этом молчат). См. тот же приём в `/admin/display-screens`.
 */

export interface AppRoleFormState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export const initialAppRoleFormState: AppRoleFormState = {};
