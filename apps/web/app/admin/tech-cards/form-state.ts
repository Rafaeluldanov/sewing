// State объекты для server actions из `./actions.ts`. Файл с
// `'use server'` обязан экспортировать только async-функции, поэтому
// initial-значения и связанные интерфейсы вынесены сюда (тот же
// паттерн, что у `/admin/routes/form-state.ts`).

export interface TechCardFormState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialTechCardFormState: TechCardFormState = {};
