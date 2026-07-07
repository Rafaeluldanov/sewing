'use server';

/**
 * Server actions раздела «Интеграции» (связь с внешним ERP upgifts).
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')`). Раздел на
 * фронте дополнительно скрыт флагом `FEATURE_ERP_INTEGRATION`
 * (`isErpIntegrationEnabled`) и `app/admin/layout.tsx`.
 *
 * Типы состояния — в `./integration-form-state.ts` (файл с `'use server'`
 * может экспортировать только async-функции).
 */

import { revalidatePath } from 'next/cache';
import {
  UpdateIntegrationSettingsSchema,
  type UpdateIntegrationSettingsDto,
} from '@sewing/shared/integration';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  testUpgiftsConnection,
  updateIntegrationSettings,
} from '@/lib/integration-api';
import type {
  TestUpgiftsConnectionState,
  UpdateIntegrationSettingsState,
} from './integration-form-state';

const ADMIN_PATH = '/admin/company-settings';

/** Строковые поля (мягкая семантика '' → null применяется Zod-ом). */
const STRING_FIELDS = [
  'upgiftsBaseUrl',
  'upgiftsTenant',
  'upgiftsEmail',
  'upgiftsOrganizationId',
] as const;

function buildIntegrationDto(form: FormData): UpdateIntegrationSettingsDto {
  const dto: Record<string, string | boolean | undefined> = {};

  for (const key of STRING_FIELDS) {
    const v = form.get(key);
    if (v === null) continue;
    dto[key] = String(v);
  }

  // Пароль: input в форме всегда есть, но пустое значение = «не менять»
  // (Zod-preprocess вернёт undefined). Никогда не рендерим сохранённый
  // пароль обратно в форму.
  const pwd = form.get('upgiftsPassword');
  if (pwd !== null) dto.upgiftsPassword = String(pwd);

  // Чекбокс «включено»: браузер не шлёт unchecked, поэтому различаем
  // через hidden-marker `upgiftsEnabled__present` (см. секцию).
  if (form.get('upgiftsEnabled__present') !== null) {
    dto.upgiftsEnabled = form.get('upgiftsEnabled') !== null;
  }

  return dto as UpdateIntegrationSettingsDto;
}

export async function updateIntegrationSettingsAction(
  _prev: UpdateIntegrationSettingsState,
  form: FormData,
): Promise<UpdateIntegrationSettingsState> {
  const parsed = UpdateIntegrationSettingsSchema.safeParse(
    buildIntegrationDto(form),
  );
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await updateIntegrationSettings(parsed.data);
    revalidatePath(ADMIN_PATH);
    return { ok: true, successMessage: 'Настройки интеграции сохранены.' };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e), errorRequestId: e.requestId };
    }
    return { error: 'Не удалось сохранить настройки интеграции' };
  }
}

/**
 * Кнопка «Проверить соединение»: дёргает
 * `POST /api/integrations/upgifts/test-connection`. Backend сам
 * fail-soft (возвращает `{ ok:false, message }`, а не 5xx), поэтому
 * `error` тут — только про сбой обращения к НАШЕМУ API.
 * `revalidatePath` обновляет `lastConnection*` в форме.
 */
export async function testUpgiftsConnectionAction(
  _prev: TestUpgiftsConnectionState,
  _form: FormData,
): Promise<TestUpgiftsConnectionState> {
  try {
    const result = await testUpgiftsConnection();
    revalidatePath(ADMIN_PATH);
    return { result };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e) };
    }
    return { error: 'Не удалось выполнить проверку соединения' };
  }
}
