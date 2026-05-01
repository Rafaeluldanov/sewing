// State объекты для server actions из `./actions.ts`. Файл
// с `'use server'` обязан экспортировать только async-функции, поэтому
// initial-значения и связанные интерфейсы вынесены сюда.

export interface CreateRouteTemplateState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateRouteTemplateState: CreateRouteTemplateState = {};

export interface UpdateRouteTemplateState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateRouteTemplateState: UpdateRouteTemplateState = {};
