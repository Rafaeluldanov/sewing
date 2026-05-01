// Состояния форм и initial-значения для server actions из `./actions.ts`.
//
// Файл с `'use server'` обязан экспортировать ТОЛЬКО async-функции
// (Next.js 14+: «A "use server" file can only export async functions»).
// Поэтому объекты-константы и связанные интерфейсы вынесены сюда —
// клиентские формы импортируют их напрямую без накладных расходов.

export interface CreateOperationState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
  /**
   * ID операции, которую action всё-таки успел создать до того, как
   * упало связывание с оборудованием. Нужен, чтобы UI мог показать
   * прямую ссылку «Открыть карточку и доделать привязку вручную»
   * вместо ощущения «всё сломалось». См. `createOperationAction`.
   */
  partialOperationId?: string;
}

export const initialCreateOperationState: CreateOperationState = {};

export interface UpdateOperationState {
  ok?: boolean;
  /** Подсказка после успешного сохранения (UI её показывает баннером). */
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateOperationState: UpdateOperationState = {};
