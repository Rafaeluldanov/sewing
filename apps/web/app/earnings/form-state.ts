/**
 * Состояние формы ручной правки окладной записи. Вынесено из
 * `'use server'` файла `actions.ts`, т.к. серверный модуль может
 * экспортировать только async-функции — объект
 * `initialUpdateSalaryEntryState` рядом с ними роняет рендер страницы
 * целиком («A "use server" file can only export async functions,
 * found object»).
 */

export interface UpdateSalaryEntryState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateSalaryEntryState: UpdateSalaryEntryState = {};
