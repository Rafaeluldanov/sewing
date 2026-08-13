'use server';

/**
 * Server actions карточки «Ассистент (ИИ)» на вкладке «Интеграции».
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')` в
 * `IntegrationsController`). Карточка на фронте дополнительно скрыта
 * флагом `FEATURE_AI_ASSISTANT` (`isAssistantEnabled`).
 *
 * Настройки ассистента едут той же ручкой `PATCH /api/integrations/settings`,
 * что и настройки upgifts: это одна singleton-строка на тенант.
 *
 * Типы состояния — в `./assistant-form-state.ts` (файл с `'use server'`
 * может экспортировать только async-функции).
 */

import { revalidatePath } from 'next/cache';
import {
  UpdateIntegrationSettingsSchema,
  type UpdateIntegrationSettingsDto,
} from '@sewing/shared/integration';
import { ApiRequestError, errorText } from '@/lib/api';
import { testAssistantKey, updateIntegrationSettings } from '@/lib/integration-api';
import type {
  TestAssistantKeyState,
  UpdateAssistantSettingsState,
} from './assistant-form-state';

const ADMIN_PATH = '/admin/company-settings';

/**
 * Чекбоксы: браузер не шлёт unchecked-поле, поэтому наличие значения
 * определяем по hidden-маркеру `<name>__present` — тот же приём, что в
 * секции upgifts.
 */
function readCheckbox(
  form: FormData,
  name: string,
  dto: Record<string, unknown>,
): void {
  if (form.get(`${name}__present`) !== null) {
    dto[name] = form.get(name) !== null;
  }
}

/** Число из формы. Пустое поле ⇒ не трогаем. */
function readNumber(
  form: FormData,
  name: string,
  dto: Record<string, unknown>,
): void {
  const raw = form.get(name);
  if (raw === null || String(raw).trim() === '') return;
  const parsed = Number(String(raw).replace(',', '.'));
  if (Number.isFinite(parsed)) dto[name] = Math.round(parsed);
}

function buildAssistantDto(form: FormData): UpdateIntegrationSettingsDto {
  const dto: Record<string, unknown> = {};

  const keySource = form.get('assistantKeySource');
  if (keySource !== null) dto.assistantKeySource = String(keySource);

  const model = form.get('assistantModel');
  if (model !== null) dto.assistantModel = String(model);

  // Ключ: пустое значение = «не менять» (Zod-preprocess вернёт undefined).
  // Сохранённый ключ обратно в форму НЕ рендерим никогда.
  const apiKey = form.get('assistantApiKey');
  if (apiKey !== null) dto.assistantApiKey = String(apiKey);

  readNumber(form, 'assistantDailyLimitPerUser', dto);

  // В форме потолок вводится в долларах — в API уезжает в центах.
  const budgetUsd = form.get('assistantMonthlyBudgetUsd');
  if (budgetUsd !== null && String(budgetUsd).trim() !== '') {
    const parsed = Number(String(budgetUsd).replace(',', '.'));
    if (Number.isFinite(parsed)) {
      dto.assistantMonthlyBudgetCents = Math.round(parsed * 100);
    }
  }

  for (const name of [
    'assistantEnabled',
    'assistantScopeProduction',
    'assistantScopeSupply',
    'assistantScopeMoney',
    'assistantScopePayroll',
  ]) {
    readCheckbox(form, name, dto);
  }

  return dto as UpdateIntegrationSettingsDto;
}

export async function updateAssistantSettingsAction(
  _prev: UpdateAssistantSettingsState,
  form: FormData,
): Promise<UpdateAssistantSettingsState> {
  const parsed = UpdateIntegrationSettingsSchema.safeParse(
    buildAssistantDto(form),
  );
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await updateIntegrationSettings(parsed.data);
    revalidatePath(ADMIN_PATH);
    return { ok: true, successMessage: 'Настройки ассистента сохранены.' };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e), errorRequestId: e.requestId };
    }
    return { error: 'Не удалось сохранить настройки ассистента' };
  }
}

/**
 * Кнопка «Проверить ключ»: дёргает `POST /api/integrations/assistant/test-key`.
 * Backend fail-soft (возвращает `{ ok:false, message }`, а не 5xx),
 * поэтому `error` тут — только про сбой обращения к НАШЕМУ API.
 */
export async function testAssistantKeyAction(
  _prev: TestAssistantKeyState,
  _form: FormData,
): Promise<TestAssistantKeyState> {
  try {
    const result = await testAssistantKey();
    revalidatePath(ADMIN_PATH);
    return { result };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e) };
    }
    return { error: 'Не удалось выполнить проверку ключа' };
  }
}
