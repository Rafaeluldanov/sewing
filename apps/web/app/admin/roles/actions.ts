'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ROLE_WORKSPACES,
  type CreateAppRoleDto,
  type UpdateAppRoleDto,
} from '@sewing/shared/app-roles';
import { ApiRequestError, errorText } from '@/lib/api';
import { createAppRole, updateAppRole } from '@/lib/app-roles-api';
import type { AppRoleFormState } from './form-state';

/**
 * Server actions раздела «Роли» (`/admin/roles`).
 *
 * RBAC — на backend (`@Roles('ADMIN')` на `AppRolesController`).
 * Фронт дополнительно прячет пункт меню у не-админа.
 *
 * ВАЖНО: файл с `'use server'` может экспортировать только
 * async-функции — initial state и типы лежат в `./form-state.ts`.
 */

/**
 * Разбирает чекбоксы «наследует роли» из FormData. В форме это
 * `<input type="checkbox" name="inherits" value="SHOP_MANAGER">`, и
 * при множественном выборе Next отдаёт несколько значений — берём все.
 */
function readInherits(form: FormData): string[] {
  return form
    .getAll('inherits')
    .map((v) => String(v).trim().toUpperCase())
    .filter((v) => v.length > 0);
}

function readWorkspace(form: FormData): string {
  const raw = String(form.get('workspace') ?? '/').trim();
  return (ROLE_WORKSPACES as readonly string[]).includes(raw) ? raw : '/';
}

/**
 * Создание роли. Локально проверяем только то, что даёт понятную
 * ошибку без round-trip (код и название); остальное — Zod на бэке
 * (`CreateAppRoleSchema`), он же нормализует код в UPPER_SNAKE.
 */
export async function createAppRoleAction(
  _prev: AppRoleFormState,
  form: FormData,
): Promise<AppRoleFormState> {
  const code = String(form.get('code') ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  const name = String(form.get('name') ?? '').trim();

  if (code.length < 2) {
    return { error: 'Код роли должен быть не короче 2 символов' };
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) {
    return {
      error:
        'Код роли — только латиница, цифры и подчёркивание, начинается с буквы (например TECHNOLOGIST)',
    };
  }
  if (name.length < 2) {
    return { error: 'Название роли должно быть не короче 2 символов' };
  }

  const lockToWorkspace = form.get('lockToWorkspace') === 'on';
  const dto: CreateAppRoleDto = {
    code,
    name,
    inherits: readInherits(form),
    workspace: readWorkspace(form),
    // «Запереть» подразумевает «одно окно» — бэкенд это тоже
    // нормализует, но пусть UI не отправляет заведомо противоречивое.
    singleWorkspace: lockToWorkspace || form.get('singleWorkspace') === 'on',
    lockToWorkspace,
  };

  let createdId: string | null = null;
  try {
    const created = await createAppRole(dto);
    createdId = created.id;
    revalidatePath('/admin/roles');
    // Список ролей виден и в формах сотрудника — обновим и его.
    revalidatePath('/admin/employees');
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e), errorRequestId: e.requestId };
    }
    return { error: 'Не удалось создать роль' };
  }
  // redirect выбрасывает NEXT_REDIRECT — выносим за try, иначе catch
  // перехватит его и превратит в ошибку формы.
  if (createdId) redirect(`/admin/roles/${createdId}`);
  return { ok: true };
}

/**
 * Правка роли. У системной роли форма отдаёт только название —
 * структурные поля бэкенд всё равно отвергнет
 * (`APP_ROLE_SYSTEM_IMMUTABLE`).
 */
export async function updateAppRoleAction(
  _prev: AppRoleFormState,
  form: FormData,
): Promise<AppRoleFormState> {
  const id = String(form.get('id') ?? '').trim();
  if (!id) return { error: 'Не указана роль' };

  const name = String(form.get('name') ?? '').trim();
  if (name.length < 2) {
    return { error: 'Название роли должно быть не короче 2 символов' };
  }

  const isSystem = form.get('system') === '1';
  const lockToWorkspace = form.get('lockToWorkspace') === 'on';

  const dto: UpdateAppRoleDto = isSystem
    ? { name }
    : {
        name,
        inherits: readInherits(form),
        workspace: readWorkspace(form),
        singleWorkspace:
          lockToWorkspace || form.get('singleWorkspace') === 'on',
        lockToWorkspace,
      };

  try {
    await updateAppRole(id, dto);
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e), errorRequestId: e.requestId };
    }
    return { error: 'Не удалось сохранить роль' };
  }
  revalidatePath('/admin/roles');
  revalidatePath(`/admin/roles/${id}`);
  revalidatePath('/admin/employees');
  return { ok: true };
}
