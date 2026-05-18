'use server';

/**
 * Server actions для админских страниц `/admin/constructor-tasks/*`.
 *
 * На MVP — только cancel (см. ТЗ §«Что НЕ делаем» из родительского
 * PR). Полная семантика жизненного цикла (`IN_PROGRESS` / `DONE`)
 * появится вместе с кабинетом конструктора.
 */

import { revalidatePath } from 'next/cache';
import { ApiRequestError } from '@/lib/api';
import { cancelConstructorTask } from '@/lib/constructor-tasks-api';

export interface CancelConstructorTaskResult {
  ok: boolean;
  error?: string;
}

export async function cancelConstructorTaskAction(
  id: string,
): Promise<CancelConstructorTaskResult> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Неверный id заявки' };
  }
  try {
    await cancelConstructorTask(id);
    // Обновляем кеши списка и детальной — статус изменился.
    revalidatePath('/admin/constructor-tasks');
    revalidatePath(`/admin/constructor-tasks/${id}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        error: e.message || 'Не удалось отменить заявку',
      };
    }
    return {
      ok: false,
      error:
        (e as Error)?.message ?? 'Не удалось отменить заявку',
    };
  }
}
