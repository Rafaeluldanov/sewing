'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiRequestError, errorText } from '@/lib/api';
import { createEquipment } from '@/lib/equipment-api';
import type { CreateEquipmentState } from './form-state';

/**
 * Server action для создания нового оборудования из `/admin/equipment`.
 *
 * Контракт UI:
 *   - `name` обязателен (валидация повторно проверяется на backend);
 *   - `code` опционален — если пуст, backend сгенерирует slug имени;
 *   - `displayNumber` опционален (пустая строка = `null`);
 *   - `operationIds` — мультивыбор (FormData.getAll), порядок выбора
 *     становится `sortOrder` (`(i + 1) * 10`).
 *
 * После успешного создания ревалидируем `/admin/equipment` и
 * редиректим на карточку нового станка — менеджер сразу попадает
 * в detail и может допроставить остальное (печать QR, операции,
 * номер). Тот же паттерн использует `/admin/warehouses`.
 */
export async function createEquipmentAction(
  _prev: CreateEquipmentState,
  form: FormData,
): Promise<CreateEquipmentState> {
  const name = String(form.get('name') ?? '').trim();
  if (name.length === 0) {
    return { error: 'Название обязательно' };
  }

  const code = String(form.get('code') ?? '').trim();
  const displayNumber = String(form.get('displayNumber') ?? '').trim();
  const operationIds = form
    .getAll('operationIds')
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);

  let createdId: string | null = null;
  try {
    const created = await createEquipment({
      name,
      code: code.length > 0 ? code : undefined,
      displayNumber: displayNumber.length > 0 ? displayNumber : null,
      operationIds: operationIds.length > 0 ? operationIds : undefined,
    });
    createdId = created.id;
    revalidatePath('/admin/equipment');
    revalidatePath('/work');
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: errorText(e),
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось создать оборудование' };
  }
  if (createdId) {
    redirect(`/admin/equipment/${createdId}`);
  }
  return { ok: true, successMessage: 'Оборудование создано' };
}
