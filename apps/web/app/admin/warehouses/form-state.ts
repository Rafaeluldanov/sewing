// Состояния форм и initial-значения для server actions из `./actions.ts`.
//
// Файл с `'use server'` обязан экспортировать ТОЛЬКО async-функции
// (Next.js 14+: «A "use server" file can only export async functions»).
// Поэтому объекты-константы и связанные интерфейсы вынесены сюда —
// клиентские формы импортируют их напрямую без накладных расходов.

export interface CreateWarehouseState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateWarehouseState: CreateWarehouseState = {};

export interface UpdateWarehouseState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateWarehouseState: UpdateWarehouseState = {};

export interface AssignCellState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export const initialAssignCellState: AssignCellState = {};

export interface CreateLineState {
  ok?: boolean;
  /** Краткое сообщение «создано N ячеек кодом X1..XN» — показываем после успеха. */
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateLineState: CreateLineState = {};
