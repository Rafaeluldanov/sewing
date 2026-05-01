// Состояния форм и initial-значения для server actions из `./actions.ts`.
// Файл с `'use server'` обязан экспортировать только async-функции.

export interface CreatePrinterState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}
export const initialCreatePrinterState: CreatePrinterState = {};

export interface UpdatePrinterState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}
export const initialUpdatePrinterState: UpdatePrinterState = {};

export interface ActionState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}
export const initialActionState: ActionState = {};
