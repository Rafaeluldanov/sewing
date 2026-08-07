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

/**
 * Состояние формы создания сотрудника на `/admin/employees/new`.
 *
 * При успехе action редиректит на карточку нового сотрудника
 * (`/admin/employees/[id]`), поэтому `successMessage` тут можно не
 * показывать — но поле оставлено симметрично `UpdateEmployeeState`,
 * чтобы UI-структура форм была одинаковой.
 */
export interface CreateEmployeeState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateEmployeeState: CreateEmployeeState = {};

/**
 * Состояние формы «Смена PIN» в карточке сотрудника.
 *
 * Отдельно от `UpdateEmployeeState`, потому что и форма отдельная:
 * сохранение зарплаты не должно иметь ни малейшего шанса сбросить код,
 * по которому человек логинится в цехе.
 */
export interface UpdateEmployeePinState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateEmployeePinState: UpdateEmployeePinState = {};

/**
 * Результат нажатия «Показать» в блоке «Доступ».
 *
 * Три исхода, и все три — нормальные:
 *   - `pin` — код показан;
 *   - `notice` — показывать нечего (PIN задан до появления обратимого
 *     хранения либо не настроен ключ шифрования): не ошибка, а
 *     подсказка «задайте PIN заново формой ниже»;
 *   - `error` — 403/404/сеть.
 */
export interface RevealEmployeePinState {
  pin?: string;
  notice?: string;
  error?: string;
  errorRequestId?: string;
}
