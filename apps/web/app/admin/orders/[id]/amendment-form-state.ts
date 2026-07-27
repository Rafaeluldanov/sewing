/**
 * Состояния форм фичи «Правка заказа в производстве» (order
 * amendments). Вынесено из `'use server'` файла `amendment-actions.ts`,
 * т.к. серверный модуль может экспортировать только async-функции —
 * объекты `initial*FormState` рядом с ними роняют рендер страницы
 * целиком («A "use server" file can only export async functions,
 * found object»).
 */

import type {
  OperationAmendmentResultDto,
  QuantityAmendmentResultDto,
  RouteAmendmentResultDto,
  SizeAmendmentResultDto,
} from '@sewing/shared';

export interface QuantityAmendmentFormState {
  ok: boolean;
  error?: string | null;
  result?: QuantityAmendmentResultDto | null;
  /** Меняется на каждый успешный submit — триггер эффектов на клиенте. */
  doneToken?: string;
}

export const initialQuantityAmendmentFormState: QuantityAmendmentFormState = {
  ok: false,
};

export interface SizeAmendmentFormState {
  ok: boolean;
  error?: string | null;
  result?: SizeAmendmentResultDto | null;
  doneToken?: string;
}

export const initialSizeAmendmentFormState: SizeAmendmentFormState = {
  ok: false,
};

export interface OperationAmendmentFormState {
  ok: boolean;
  error?: string | null;
  result?: OperationAmendmentResultDto | null;
  doneToken?: string;
}

export const initialOperationAmendmentFormState: OperationAmendmentFormState = {
  ok: false,
};

/**
 * ФАЗА 3.1 — правка маршрута целиком (вкладка «Маршрут» drawer-а).
 * `payload` — весь целевой маршрут (`ApplyRouteAmendmentSchema`), дельту
 * считает бэкенд: он же стережёт замороженный префикс до фронта.
 */
export interface RouteAmendmentFormState {
  ok: boolean;
  error?: string | null;
  result?: RouteAmendmentResultDto | null;
  doneToken?: string;
}

export const initialRouteAmendmentFormState: RouteAmendmentFormState = {
  ok: false,
};
