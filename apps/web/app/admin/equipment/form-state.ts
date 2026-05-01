// Состояния форм и initial-значения для server actions из `./actions.ts`.
//
// Файл с `'use server'` обязан экспортировать ТОЛЬКО async-функции
// (Next.js 14+: «A "use server" file can only export async functions»).
// Поэтому объекты-константы и связанные интерфейсы вынесены сюда —
// клиентские формы импортируют их напрямую без накладных расходов.

export interface CreateEquipmentState {
  ok?: boolean;
  /** Краткое сообщение «оборудование создано» — показываем после успеха. */
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateEquipmentState: CreateEquipmentState = {};
