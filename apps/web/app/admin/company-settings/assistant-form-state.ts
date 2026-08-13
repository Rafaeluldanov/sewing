/**
 * Типы и initial state для формы карточки «Ассистент (ИИ)» на вкладке
 * «Интеграции». Вынесено из `./assistant-actions.ts`, потому что файл с
 * `'use server'` может экспортировать только async-функции — иначе
 * страница падает молча.
 */

import type { AssistantTestKeyResult } from '@sewing/shared/integration';

export interface UpdateAssistantSettingsState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateAssistantSettingsState: UpdateAssistantSettingsState =
  {};

/**
 * State кнопки «Проверить ключ». `result` — ответ backend
 * (`{ ok, message }`), `error` — сбой обращения к НАШЕМУ API, а не к
 * Anthropic.
 */
export interface TestAssistantKeyState {
  result?: AssistantTestKeyResult;
  error?: string;
}

export const initialTestAssistantKeyState: TestAssistantKeyState = {};
