/**
 * Типы и initial state для форм раздела «Интеграции» (связь с внешним
 * ERP upgifts). Вынесено из `./integrations-actions.ts`, потому что файл
 * с `'use server'` может экспортировать только async-функции.
 */

import type { UpgiftsTestConnectionResult } from '@sewing/shared/integration';

export interface UpdateIntegrationSettingsState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateIntegrationSettingsState: UpdateIntegrationSettingsState =
  {};

/**
 * State кнопки «Проверить соединение». `result` — ответ backend
 * (`{ ok, message, principal? }`), `error` — сбой самого запроса к
 * нашему API (не к upgifts).
 */
export interface TestUpgiftsConnectionState {
  result?: UpgiftsTestConnectionResult;
  error?: string;
}

export const initialTestUpgiftsConnectionState: TestUpgiftsConnectionState = {};
