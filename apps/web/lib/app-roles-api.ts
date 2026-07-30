/**
 * Серверные обёртки над Nest API справочника ролей (`/api/app-roles`,
 * см. `docs/api.md §3c`).
 *
 * Используются из RSC `/admin/roles`, из карточки сотрудника (селекты
 * ролей) и из server actions создания/правки роли.
 */

import type {
  AppRoleDto,
  CreateAppRoleDto,
  UpdateAppRoleDto,
} from '@sewing/shared/app-roles';
import { apiFetch } from './api';

/** Весь справочник: и активные роли, и архив (вкладки делит страница). */
export function listAppRoles(): Promise<AppRoleDto[]> {
  return apiFetch<AppRoleDto[]>('/app-roles');
}

export function getAppRole(id: string): Promise<AppRoleDto> {
  return apiFetch<AppRoleDto>(`/app-roles/${id}`);
}

export function createAppRole(body: CreateAppRoleDto): Promise<AppRoleDto> {
  return apiFetch<AppRoleDto>('/app-roles', { method: 'POST', body });
}

export function updateAppRole(
  id: string,
  body: UpdateAppRoleDto,
): Promise<AppRoleDto> {
  return apiFetch<AppRoleDto>(`/app-roles/${id}`, { method: 'PATCH', body });
}

/**
 * Справочник для мест, где роли только ПОКАЗЫВАЮТ или НАЗНАЧАЮТ
 * (карточка сотрудника, `formatRole`). Ошибку не пробрасываем: если
 * справочник недоступен, вызывающая страница должна отрисоваться на
 * системных ролях, а не упасть целиком.
 */
export async function listAppRolesSafe(): Promise<AppRoleDto[]> {
  try {
    return await listAppRoles();
  } catch {
    return [];
  }
}
