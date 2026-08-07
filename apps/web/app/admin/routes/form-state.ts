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

/**
 * Inline-режим (модалка «＋ Добавить маршрут…» из select-ов форм
 * заказов): вместо redirect на карточку шаблона action возвращает
 * созданный DTO — хост мержит его в список и автовыбирает.
 */
export interface CreateRouteTemplateInlineState {
  ok?: boolean;
  template?: import('@sewing/shared/routes').RouteTemplateDetailDto;
  /** Не используется в inline-режиме; поле нужно для type-совместимости union-а в RouteTemplateForm. */
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateRouteTemplateInlineState: CreateRouteTemplateInlineState =
  {};
