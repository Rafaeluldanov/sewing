'use server';

import { revalidatePath } from 'next/cache';
import { ApiRequestError, errorText } from '@/lib/api';
import { updateSalaryEntry } from '@/lib/salary-api';
// Тип и initial state живут в отдельном модуле: `'use server'` файл
// может экспортировать только async-функции.
import type { UpdateSalaryEntryState } from './form-state';

/**
 * Server action ручной правки окладной записи (см. `docs/api.md §10a`,
 * ADR-0021). Доступна только `SHOP_MANAGER`/`ADMIN` — backend ставит
 * `@Roles(...)` на `PATCH /api/salary/:id`.
 *
 * Передаём `amount`/`managerComment`/`reset` — pristine, без подмены
 * `employeeId/date/source` (этих полей нет в DTO).
 */
export async function updateSalaryEntryAction(
  entryId: string,
  _prev: UpdateSalaryEntryState,
  form: FormData,
): Promise<UpdateSalaryEntryState> {
  const reset = form.get('reset') === '1';

  if (reset) {
    try {
      await updateSalaryEntry(entryId, { reset: true });
      revalidatePath('/earnings');
      return { ok: true, successMessage: 'Сумма возвращена под автоматику.' };
    } catch (e) {
      return apiError(e, 'Не удалось сбросить ручную правку');
    }
  }

  const amountRaw = String(form.get('amount') ?? '').trim();
  const commentRaw = String(form.get('managerComment') ?? '').trim();

  if (amountRaw === '' && commentRaw === '') {
    return { error: 'Введите сумму или комментарий' };
  }

  const body: { amount?: number; managerComment?: string | null } = {};
  if (amountRaw !== '') {
    const num = Number(amountRaw.replace(',', '.'));
    if (!Number.isFinite(num) || num < 0) {
      return { error: 'Введите валидную сумму' };
    }
    body.amount = num;
  }
  if (commentRaw !== '') {
    body.managerComment = commentRaw;
  }

  try {
    await updateSalaryEntry(entryId, body);
    revalidatePath('/earnings');
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    return apiError(e, 'Не удалось сохранить начисление');
  }
}

function apiError(e: unknown, fallback: string): UpdateSalaryEntryState {
  if (e instanceof ApiRequestError) {
    return {
      error: errorText(e),
      errorRequestId: e.requestId,
    };
  }
  return { error: fallback };
}
