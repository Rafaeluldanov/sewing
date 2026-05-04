'use server';

/**
 * Server actions блока «Настройки компании».
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')`). Frontend
 * дополнительно скрывает раздел через `app/admin/layout.tsx`.
 *
 * ВАЖНО: файл с `'use server'` может экспортировать только async-
 * функции, типы и initial state живут в `./form-state.ts`.
 */

import { revalidatePath } from 'next/cache';
import {
  UpdateCompanySettingsSchema,
  type UpdateCompanySettingsDto,
} from '@sewing/shared/company-settings';
import {
  CreateCompanyDivisionSchema,
  UpdateCompanyDivisionSchema,
  type CreateCompanyDivisionDto,
  type UpdateCompanyDivisionDto,
} from '@sewing/shared/company-divisions';
import { ApiRequestError } from '@/lib/api';
import {
  createCompanyDivision,
  updateCompanyDivision,
  updateCompanySettings,
} from '@/lib/company-settings-api';
import type {
  CreateCompanyDivisionState,
  UpdateCompanyDivisionState,
  UpdateCompanySettingsState,
} from './form-state';

const ADMIN_PATH = '/admin/company-settings';

function explainApiError(e: unknown): { error: string; requestId?: string } {
  if (e instanceof ApiRequestError) {
    return {
      error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
      requestId: e.requestId,
    };
  }
  return { error: 'Не удалось выполнить запрос' };
}

// ---------------------------------------------------------------------------
// Settings (singleton)
// ---------------------------------------------------------------------------

const SETTINGS_FIELDS = [
  'legalName',
  'shortName',
  'inn',
  'kpp',
  'ogrn',
  'legalAddress',
  'actualAddress',
  'phone',
  'email',
  'directorName',
  'accountantName',
  'bankName',
  'bik',
  'correspondentAccount',
  'settlementAccount',
] as const;

/**
 * Boolean-флаги блока «Материалы и склад». В отличие от строковых
 * реквизитов, браузер не посылает unchecked-checkbox в `FormData`
 * (stale `null`), поэтому явно различаем их через hidden-маркер
 * `${name}__present`, который рендерит форма (см. settings-form.tsx).
 */
const SETTINGS_BOOLEAN_FIELDS = [
  'autoIssueMaterialsOnCutRelease',
  'allowNegativeMaterialStock',
] as const;

function buildSettingsDto(form: FormData): UpdateCompanySettingsDto {
  // Семантика — как в `clients/actions.ts::buildUpdateDto`: поле есть в
  // форме (`!== null`) → передаём как строку (включая пустую, которая
  // через preprocess превратится в `null`), иначе оставляем
  // `undefined` — backend такие не трогает.
  const dto: Record<string, string | boolean | undefined> = {};
  for (const key of SETTINGS_FIELDS) {
    const v = form.get(key);
    if (v === null) continue;
    dto[key] = String(v);
  }
  for (const key of SETTINGS_BOOLEAN_FIELDS) {
    // hidden-marker `${key}__present` ставится формой всегда;
    // `${key}` приходит только если чекбокс включён → браузер шлёт
    // `on` (`checked`-default). Отсутствие marker-а означает, что
    // блок не рендерился вовсе — поле не трогаем.
    if (form.get(`${key}__present`) === null) continue;
    dto[key] = form.get(key) !== null;
  }
  return dto as UpdateCompanySettingsDto;
}

export async function updateCompanySettingsAction(
  _prev: UpdateCompanySettingsState,
  form: FormData,
): Promise<UpdateCompanySettingsState> {
  const parsed = UpdateCompanySettingsSchema.safeParse(buildSettingsDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await updateCompanySettings(parsed.data);
    revalidatePath(ADMIN_PATH);
    return { ok: true, successMessage: 'Реквизиты сохранены.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Divisions (CRUD)
// ---------------------------------------------------------------------------

function buildCreateDivisionDto(form: FormData): CreateCompanyDivisionDto {
  const sortOrderRaw = form.get('sortOrder');
  const sortOrder = sortOrderRaw === null || sortOrderRaw === ''
    ? undefined
    : Number(sortOrderRaw);
  return {
    code: String(form.get('code') ?? '').trim(),
    name: String(form.get('name') ?? '').trim(),
    description:
      form.get('description') === null
        ? undefined
        : String(form.get('description') ?? ''),
    sortOrder: sortOrder !== undefined && Number.isFinite(sortOrder)
      ? sortOrder
      : undefined,
  };
}

function buildUpdateDivisionDto(form: FormData): UpdateCompanyDivisionDto {
  const dto: UpdateCompanyDivisionDto = {};
  if (form.get('code') !== null) {
    dto.code = String(form.get('code') ?? '').trim();
  }
  if (form.get('name') !== null) {
    dto.name = String(form.get('name') ?? '').trim();
  }
  if (form.get('description') !== null) {
    dto.description = String(form.get('description') ?? '');
  }
  if (form.get('sortOrder') !== null) {
    const n = Number(form.get('sortOrder'));
    if (Number.isFinite(n)) dto.sortOrder = n;
  }
  if (form.get('isActive') !== null) {
    dto.isActive = form.get('isActive') === 'on';
  }
  return dto;
}

export async function createCompanyDivisionAction(
  _prev: CreateCompanyDivisionState,
  form: FormData,
): Promise<CreateCompanyDivisionState> {
  const parsed = CreateCompanyDivisionSchema.safeParse(
    buildCreateDivisionDto(form),
  );
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await createCompanyDivision(parsed.data);
    revalidatePath(ADMIN_PATH);
    return { ok: true, successMessage: 'Подразделение создано.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function updateCompanyDivisionAction(
  divisionId: string,
  _prev: UpdateCompanyDivisionState,
  form: FormData,
): Promise<UpdateCompanyDivisionState> {
  const parsed = UpdateCompanyDivisionSchema.safeParse(
    buildUpdateDivisionDto(form),
  );
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await updateCompanyDivision(divisionId, parsed.data);
    revalidatePath(ADMIN_PATH);
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * Тонкий wrapper над `updateCompanyDivisionAction` для inline-кнопки
 * «Включить» / «Отключить» в таблице. Не использует form-state, потому
 * что вызов идёт строго из `<form action={…}>` без `useFormState`.
 */
export async function toggleCompanyDivisionActiveAction(
  form: FormData,
): Promise<void> {
  const id = String(form.get('id') ?? '');
  const next = form.get('isActive') === 'true';
  if (!id) return;
  try {
    await updateCompanyDivision(id, { isActive: next });
  } catch {
    // Inline-toggle сознательно fail-soft: ошибку увидит пользователь
    // через basic redirect-revalidate (обновлённый список покажет
    // прежнее состояние). Подробной диагностики не показываем — для
    // редактирования есть `EditDivisionForm` со своим error-box.
  }
  revalidatePath(ADMIN_PATH);
}
