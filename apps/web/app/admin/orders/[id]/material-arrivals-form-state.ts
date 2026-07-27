/**
 * Состояние форм блока «Приход материала» в карточке заказа. Вынесено
 * из `'use server'` файла `material-arrivals-actions.ts`, т.к. серверный
 * модуль может экспортировать только async-функции — объект
 * `initialOrderMaterialArrivalsFormState` рядом с ними роняет рендер
 * страницы целиком («A "use server" file can only export async
 * functions, found object»).
 */

export interface OrderMaterialArrivalsFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  successMessage?: string;
}

export const initialOrderMaterialArrivalsFormState: OrderMaterialArrivalsFormState =
  {};
