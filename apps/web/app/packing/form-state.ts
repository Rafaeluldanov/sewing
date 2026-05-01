// Состояние формы и initial-значение для server actions из `./actions.ts`.
//
// Файл с `'use server'` обязан экспортировать ТОЛЬКО async-функции
// (Next.js 14+: «A "use server" file can only export async functions»).
// Объект-константа и интерфейс вынесены сюда — клиентские формы
// импортируют их напрямую.

export interface PackingFormState {
  error?: string;
  info?: string;
}

export const initialPackingFormState: PackingFormState = {};
