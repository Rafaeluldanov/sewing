'use server';

import { revalidatePath } from 'next/cache';
import {
  StartShiftSchema,
  type StartShiftDto,
} from '@sewing/shared/shifts';
import { ApiRequestError } from '@/lib/api';
import {
  completePassportOperation,
  findPassportByCode,
  issuePassport,
  scanPassport,
  startShift,
  stopShift,
} from '@/lib/shifts-api';
import type { PassportLookupResponse, WorkFormState } from './state';

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return 'Не удалось выполнить запрос';
}

function errorRequestId(e: unknown): string | undefined {
  return e instanceof ApiRequestError ? e.requestId : undefined;
}

// ---------------------------------------------------------------------------
// Shift start / stop. С MVP 1.1 employeeId берётся из сессии на API.
// ---------------------------------------------------------------------------

export async function startShiftAction(
  _prev: WorkFormState,
  form: FormData,
): Promise<WorkFormState> {
  const raw: StartShiftDto = {
    equipmentId: String(form.get('equipmentId') ?? '').trim(),
    operationId: String(form.get('operationId') ?? '').trim(),
  };
  const parsed = StartShiftSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await startShift(parsed.data);
    revalidatePath('/work');
    return { info: 'Смена начата' };
  } catch (e) {
    return { error: explainApiError(e), errorRequestId: errorRequestId(e) };
  }
}

export async function stopShiftAction(
  _prev: WorkFormState,
  _form: FormData,
): Promise<WorkFormState> {
  try {
    await stopShift();
    revalidatePath('/work');
    return { info: 'Смена завершена' };
  } catch (e) {
    return { error: explainApiError(e), errorRequestId: errorRequestId(e) };
  }
}

// ---------------------------------------------------------------------------
// Issue (получить крой) / scan (любое сканирование = переход)
// ---------------------------------------------------------------------------

async function runWithPassport(
  code: string,
  op: (passportId: string) => Promise<unknown>,
  successMessage: string,
): Promise<WorkFormState> {
  const trimmed = code.trim();
  if (!trimmed) return { error: 'Введите или отсканируйте код паспорта' };
  try {
    const passport = await findPassportByCode(trimmed);
    const updated = (await op(passport.id)) as Awaited<
      ReturnType<typeof findPassportByCode>
    >;
    revalidatePath('/work');
    revalidatePath(`/passports/${passport.id}`);
    revalidatePath(`/orders/${passport.orderId}`);
    return {
      info: successMessage,
      passport: {
        id: updated.id,
        number: updated.number,
        sizeCode: updated.sizeCode,
        qtyCut: updated.qtyCut,
        qtyGood: updated.qtyGood,
        productName: updated.productName,
        color: updated.color,
        status: updated.status,
        rollNumber: updated.rollNumber,
      },
    };
  } catch (e) {
    return { error: explainApiError(e), errorRequestId: errorRequestId(e) };
  }
}

/**
 * Найти паспорт по коду — БЕЗ побочных эффектов (не делает issue/scan).
 *
 * Используется в seamstress flow на /work для модалки сверки: швея
 * сканирует QR паспорта, видит крупно номер/изделие/размер/количество и
 * либо подтверждает («Принять» → `acceptPassportForIssueAction`), либо
 * отменяет и пересканирует.
 */
export async function lookupPassportAction(
  code: string,
): Promise<PassportLookupResponse> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: 'Введите или отсканируйте код паспорта' };
  try {
    const p = await findPassportByCode(trimmed);
    return {
      ok: true,
      passport: {
        id: p.id,
        number: p.number,
        sizeCode: p.sizeCode,
        qtyCut: p.qtyCut,
        qtyGood: p.qtyGood,
        productName: p.productName,
        color: p.color,
        status: p.status,
        rollNumber: p.rollNumber,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * «Принять» паспорт после визуальной сверки в модалке seamstress flow.
 *
 * Логика — та же, что у `issuePassportAction`: проксируем `id` через
 * `findPassportByCode` (поддерживает голый id, см. ADR-0008) и зовём
 * `issuePassport`. Сохраняем revalidate, чтобы `/passports/:id` и
 * связанный заказ обновили свой server-render.
 */
export async function acceptPassportForIssueAction(
  passportId: string,
): Promise<WorkFormState> {
  return runWithPassport(passportId, (id) => issuePassport(id), 'Крой принят');
}

/**
 * «Завершить операцию» после визуальной сверки в seamstress flow.
 *
 * Симметрично `acceptPassportForIssueAction`: проксируем `id` через
 * `findPassportByCode` (поддерживает голый id, см. ADR-0008), вызываем
 * `completePassportOperation` и инвалидируем кэши `/work`, `/passports/:id`
 * и связанного заказа, чтобы блок «Текущий крой» сразу освежился.
 */
export async function completePassportOperationAction(
  passportId: string,
): Promise<WorkFormState> {
  return runWithPassport(
    passportId,
    (id) => completePassportOperation(id),
    'Операция завершена',
  );
}

export async function issuePassportAction(
  _prev: WorkFormState,
  form: FormData,
): Promise<WorkFormState> {
  const code = String(form.get('code') ?? '');
  return runWithPassport(code, (id) => issuePassport(id), 'Крой получен');
}

export async function scanPassportAction(
  _prev: WorkFormState,
  form: FormData,
): Promise<WorkFormState> {
  const code = String(form.get('code') ?? '');
  return runWithPassport(
    code,
    (id) => scanPassport(id),
    'Паспорт принят на операцию',
  );
}
