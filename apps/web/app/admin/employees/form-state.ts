/**
 * Тип и initial state для формы редактирования сотрудника
 * (`/admin/employees/[id]`).
 *
 * Вынесено из `./actions.ts`, потому что файл с директивой `'use server'`
 * в Next.js может экспортировать только async-функции — экспорт
 * объекта/константы из server-actions модуля приводит к ошибке сборки
 * вида: «A "use server" file can only export async functions, found object».
 *
 * Этот модуль НЕ помечен `'use server'` и используется как server-, так и
 * client-кодом (см. `./[id]/edit-form.tsx`).
 */

export interface UpdateEmployeeState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateEmployeeState: UpdateEmployeeState = {};
