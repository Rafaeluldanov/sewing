'use server';

import { revalidatePath } from 'next/cache';
import { ApiRequestError } from '@/lib/api';
import {
  updateEquipment,
  updateEquipmentOperations,
} from '@/lib/equipment-api';
import type {
  UpdateDisplayNumberState,
  UpdateNameState,
  UpdateOperationsState,
} from './form-state';

/**
 * Server action для `/admin/equipment/[id]`. Принимает FormData с
 * чекбоксами `operationIds` (по одному на каждую отмеченную
 * операцию) и упорядоченный hidden-список `operationOrder` —
 * sortOrder в результате будет совпадать с порядком в массиве.
 *
 * Источник истины — backend `PATCH /api/equipment/:id/operations`
 * (см. ADR-0017, `docs/api.md §3a`). Здесь — только тонкая
 * обёртка с revalidatePath, чтобы /admin/equipment и /work сразу
 * увидели новый набор.
 */
export async function updateEquipmentOperationsAction(
  equipmentId: string,
  _prev: UpdateOperationsState,
  form: FormData,
): Promise<UpdateOperationsState> {
  // FormData.getAll возвращает все значения чекбокса с одним name —
  // именно отмеченные. Дубликатов быть не должно (HTML гарантирует
  // уникальность value на одну форму).
  const checked = form
    .getAll('operationIds')
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);

  // Сохраняем порядок в стабильном виде — берём из hidden-полей
  // `operationOrder`, отфильтровываем по checked. Если порядок не
  // пришёл (старый клиент / no-JS), fallback — порядок чекбоксов
  // в form-data.
  const orderRaw = form
    .getAll('operationOrder')
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
  const checkedSet = new Set(checked);
  const ordered =
    orderRaw.length > 0
      ? orderRaw.filter((id) => checkedSet.has(id))
      : checked;

  try {
    await updateEquipmentOperations(equipmentId, { operationIds: ordered });
    revalidatePath('/admin/equipment');
    revalidatePath(`/admin/equipment/${equipmentId}`);
    revalidatePath('/work');
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось сохранить операции оборудования' };
  }
}

// ---------------------------------------------------------------------------
// displayNumber (ручной номер станка для физической маркировки)
// ---------------------------------------------------------------------------

/**
 * Server action для редактирования `Equipment.displayNumber`. Тонкая
 * обёртка над `PATCH /api/equipment/:id`. Пустое поле = сброс
 * номера в `null` (тот же контракт, что и в backend Zod-схеме).
 *
 * Ревалидируем только admin-страницы — `/work` номер пока не
 * показывает (это вторично, см. ТЗ §8): необязательно сбрасывать
 * cache всего seamstress-flow ради опечатки в номере станка.
 */
export async function updateEquipmentDisplayNumberAction(
  equipmentId: string,
  _prev: UpdateDisplayNumberState,
  form: FormData,
): Promise<UpdateDisplayNumberState> {
  const raw = form.get('displayNumber');
  const value = typeof raw === 'string' ? raw : '';

  try {
    await updateEquipment(equipmentId, { displayNumber: value });
    revalidatePath('/admin/equipment');
    revalidatePath(`/admin/equipment/${equipmentId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось сохранить номер оборудования' };
  }
}

// ---------------------------------------------------------------------------
// name (переименование оборудования)
// ---------------------------------------------------------------------------

/**
 * Server action для переименования `Equipment.name`. Тонкая обёртка
 * над `PATCH /api/equipment/:id` (см. `docs/api.md §3a`).
 *
 * Ревалидируем admin-страницы и `/work` — название показывается в
 * форме старта смены у швеи (`getShiftMeta`), и менеджер ожидает,
 * что после переименования швея сразу увидит новое имя.
 */
export async function updateEquipmentNameAction(
  equipmentId: string,
  _prev: UpdateNameState,
  form: FormData,
): Promise<UpdateNameState> {
  const raw = form.get('name');
  const name = (typeof raw === 'string' ? raw : '').trim();
  if (name.length === 0) {
    return { error: 'Название обязательно' };
  }

  try {
    await updateEquipment(equipmentId, { name });
    revalidatePath('/admin/equipment');
    revalidatePath(`/admin/equipment/${equipmentId}`);
    revalidatePath('/work');
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось сохранить изменения' };
  }
}
