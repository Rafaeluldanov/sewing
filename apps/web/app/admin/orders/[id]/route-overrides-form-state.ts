/**
 * Состояние формы «Редактировать маршрут заказа» (расценки/нормы
 * операций в рамках заказа). Вынесено из `'use server'` файла
 * `route-overrides-actions.ts`, т.к. серверный модуль может
 * экспортировать только async-функции.
 */

export interface RouteOverridesFormState {
  ok: boolean;
  error?: string;
  /** Меняется при каждом успешном сохранении — клиент по нему выходит
   *  из режима редактирования. */
  doneToken?: string;
}

export const initialRouteOverridesFormState: RouteOverridesFormState = {
  ok: false,
};
