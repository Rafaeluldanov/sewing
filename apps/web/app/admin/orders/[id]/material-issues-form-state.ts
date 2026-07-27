/**
 * Состояние форм блока «Отпуск материала» в карточке заказа.
 * Вынесено из `'use server'` файла `material-issues-actions.ts`, т.к.
 * серверный модуль может экспортировать только async-функции — объект
 * `initialMaterialIssueFormState` рядом с ними ронял рендер страницы
 * целиком («A "use server" file can only export async functions,
 * found object»).
 */

export interface MaterialIssueFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  successMessage?: string;
  /**
   * Id только что созданного документа — удобно для UI, чтобы
   * автоматически раскрыть его preview-строку или сразу показать
   * подтверждение с номером.
   */
  createdId?: string;
}

export const initialMaterialIssueFormState: MaterialIssueFormState = {};
