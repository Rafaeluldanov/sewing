'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  UpdatePassportSchema,
  type UpdatePassportDto,
} from '@sewing/shared/passports';
import { ApiRequestError, errorText } from '@/lib/api';
import { deletePassport, updatePassport } from '@/lib/passports-api';

/**
 * Server actions страницы «Выпущенные паспорта» помощника
 * раскройщика (`/work/passports`, `/work/passports/[id]/edit`).
 *
 * Контракт BFF-обёрток:
 *   - `updateMyPassportAction` — PATCH полей паспорта; на success
 *     редиректит обратно на список (как и просили в ТЗ); на ошибку
 *     возвращает `{ error }`, форма показывает inline-сообщение;
 *   - `deleteMyPassportAction` — DELETE «своего» паспорта; на success
 *     ревалидирует список и возвращается `{ ok: true }`. Кнопка
 *     удаления живёт прямо на строке списка, поэтому редирект тут
 *     не нужен — пользователь остаётся на той же странице со
 *     свежим срезом данных.
 *
 * RBAC проверяет backend (`@Roles(...)` + `creatorId === me`); фронт
 * лишь не показывает кнопки на строках с `editable = false`.
 */

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
  }
  return 'Не удалось выполнить запрос';
}

function isNextRedirect(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'digest' in e &&
    typeof (e as { digest?: unknown }).digest === 'string' &&
    (e as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

export interface UpdatePassportFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

export async function updateMyPassportAction(
  passportId: string,
  orderId: string,
  _prev: UpdatePassportFormState,
  form: FormData,
): Promise<UpdatePassportFormState> {
  const cutterIdRaw = String(form.get('cutterId') ?? '').trim();
  const sizeIdRaw = String(form.get('sizeId') ?? '').trim();
  const cutDateRaw = String(form.get('cutDate') ?? '').trim();
  const rollNumberRaw = String(form.get('rollNumber') ?? '').trim();
  const qtyCutRaw = form.get('qtyCut');

  const raw: Partial<UpdatePassportDto> = {
    ...(sizeIdRaw ? { sizeId: sizeIdRaw } : {}),
    ...(cutDateRaw ? { cutDate: cutDateRaw } : {}),
    ...(qtyCutRaw !== null && qtyCutRaw !== ''
      ? { qtyCut: Number(qtyCutRaw) }
      : {}),
    ...(rollNumberRaw ? { rollNumber: rollNumberRaw } : {}),
    ...(cutterIdRaw ? { cutterId: cutterIdRaw } : {}),
  };

  const parsed = UpdatePassportSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join('.') || '_form'] = issue.message;
    }
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
      fieldErrors,
    };
  }

  try {
    await updatePassport(passportId, parsed.data);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    return { error: explainApiError(e) };
  }

  // Обновляем все срезы, в которых паспорт может быть виден: список
  // помощника на /work/passports, карточки заказа (legacy + admin),
  // карточки самого паспорта (legacy + admin).
  revalidatePath('/work/passports');
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/passports/${passportId}`);
  revalidatePath(`/admin/passports/${passportId}`);
  redirect('/work/passports');
}

export interface DeleteMyPassportActionResult {
  ok?: true;
  error?: string;
}

export async function deleteMyPassportAction(
  passportId: string,
  orderId: string,
): Promise<DeleteMyPassportActionResult> {
  try {
    await deletePassport(passportId);
  } catch (e) {
    return { error: explainApiError(e) };
  }
  revalidatePath('/work/passports');
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/passports/${passportId}`);
  revalidatePath(`/admin/passports/${passportId}`);
  return { ok: true };
}
