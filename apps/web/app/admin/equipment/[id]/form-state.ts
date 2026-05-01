// Состояния форм и initial-значения для server actions из `./actions.ts`.
//
// Файл с `'use server'` обязан экспортировать ТОЛЬКО async-функции
// (Next.js 14+: «A "use server" file can only export async functions»).
// Поэтому объекты-константы и связанные интерфейсы вынесены сюда —
// клиентская форма импортирует их напрямую.

export interface UpdateOperationsState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateOperationsState: UpdateOperationsState = {};

export interface UpdateDisplayNumberState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateDisplayNumberState: UpdateDisplayNumberState = {};

export interface UpdateNameState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateNameState: UpdateNameState = {};
