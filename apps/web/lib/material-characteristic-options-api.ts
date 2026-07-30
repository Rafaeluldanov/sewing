/**
 * Серверные обёртки над `/api/material-characteristic-options` (см.
 * `apps/api/src/modules/material-characteristic-options/*`).
 *
 * Справочник значений поля «Характеристика» строки материала техкарты —
 * того самого, которое заменило убранное поле «Подтип». Контракты — Zod-
 * схемы из `@sewing/shared/material-characteristic-options`.
 */
import type {
  CreateMaterialCharacteristicOptionDto,
  MaterialCharacteristicOptionDto,
} from '@sewing/shared/material-characteristic-options';
import { apiFetch } from './api';

export function listMaterialCharacteristicOptions(
  roleKey?: string,
): Promise<MaterialCharacteristicOptionDto[]> {
  const path = roleKey
    ? `/material-characteristic-options?roleKey=${encodeURIComponent(roleKey)}`
    : '/material-characteristic-options';
  return apiFetch<MaterialCharacteristicOptionDto[]>(path, {
    cache: 'no-store',
  });
}

export function createMaterialCharacteristicOption(
  body: CreateMaterialCharacteristicOptionDto,
): Promise<MaterialCharacteristicOptionDto> {
  return apiFetch<MaterialCharacteristicOptionDto>(
    '/material-characteristic-options',
    { method: 'POST', body },
  );
}

export function deleteMaterialCharacteristicOption(
  id: string,
): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(
    `/material-characteristic-options/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}
