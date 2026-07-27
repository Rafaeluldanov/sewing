/**
 * Состояние формы «Нанесение» в карточке заказа. Вынесено из
 * `'use server'` файла `applications-actions.ts`, т.к. серверный
 * модуль может экспортировать только async-функции — объект
 * `initialOrderApplicationsFormState` рядом с ними ронял рендер
 * страницы целиком («A "use server" file can only export async
 * functions, found object»).
 */

export interface OrderApplicationsFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  successMessage?: string;
}

export const initialOrderApplicationsFormState: OrderApplicationsFormState = {};
