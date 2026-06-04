/**
 * Тип состояния формы и его начальное значение для server actions ручных
 * строк логистики (см. `logistics-lines-actions.ts`).
 *
 * Вынесено в ОТДЕЛЬНЫЙ модуль (без `'use server'`) намеренно: файл с
 * директивой `'use server'` может экспортировать ТОЛЬКО async-функции
 * (см. https://nextjs.org/docs/messages/invalid-use-server-value).
 * Экспорт константы `initialLogisticsLineFormState` прямо из actions-
 * файла валит прод-сборку с ошибкой «can only export async functions,
 * found object». Поэтому тип + начальное состояние живут здесь, а
 * actions-файл импортирует тип отсюда же.
 */

export interface LogisticsLineFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  successMessage?: string;
  /** Меняется при каждом успешном submit — UI закрывает диалог по нему. */
  doneToken?: string;
}

export const initialLogisticsLineFormState: LogisticsLineFormState = {};
