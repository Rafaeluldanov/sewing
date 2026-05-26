'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import {
  CreatePassportDefectSchema,
  type QcPassportDetailDto,
} from '@sewing/shared/qc';
import { ApiRequestError } from '@/lib/api';
import {
  completeQcPassport,
  getQcPassport,
  recordPassportDefect,
} from '@/lib/qc-api';
import { findPassportByCode, scanPassport } from '@/lib/shifts-api';
import type { QcDefectFormState } from './form-state';

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

function revalidateForPassport(detail: QcPassportDetailDto): void {
  revalidatePath('/qc');
  revalidatePath(`/qc/passports/${detail.passportId}`);
  revalidatePath(`/passports/${detail.passportId}`);
  revalidatePath(`/admin/passports/${detail.passportId}`);
  revalidatePath(`/orders/${detail.orderId}`);
  revalidatePath(`/admin/orders/${detail.orderId}`);
  revalidateTag('cells');
}

export async function recordDefectAction(
  passportId: string,
  _prev: QcDefectFormState,
  form: FormData,
): Promise<QcDefectFormState> {
  const raw = {
    defectTypeId: String(form.get('defectTypeId') ?? '').trim(),
    qty: Number(form.get('qty') ?? 0),
    comment: String(form.get('comment') ?? '').trim() || undefined,
  };
  const parsed = CreatePassportDefectSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    const detail = await recordPassportDefect(passportId, parsed.data);
    revalidateForPassport(detail);
    return { info: `Зафиксировано брака: ${parsed.data.qty} шт.` };
  } catch (e) {
    return { error: explainApiError(e) };
  }
}

// ---------------------------------------------------------------------------
// QC role-terminal: scan-driven actions для `/qc` (см. `qc-terminal.tsx`)
// ---------------------------------------------------------------------------

export type QcLookupResult =
  | { ok: true; detail: QcPassportDetailDto }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * Резолв паспорта по произвольному коду (QR `passport:{id}`, номер
 * `P-…`, голый id), запуск входного `OPERATION_SCAN` на ОТК (через
 * общий `POST /api/passports/:id/scan`) и одновременная загрузка
 * QC-карточки. Полный аналог `acceptOnWtoAction` — это та же
 * scan-driven модель, что у ВТО (см. `apps/web/app/wto/actions.ts`).
 *
 * Зачем нужен `scanPassport` шаг (баг-фикс ADR-0013 §«QC bucket»):
 * без него `passport.currentOperationId` не переключался на операцию
 * категории `QC`, и shopfloor-проекция (см.
 * `apps/api/src/modules/shopfloor/shopfloor-projection.ts`) никогда
 * не двигала паспорт ни в bucket `QC`, ни в `QC_DONE`. Из-за этого
 * экран «Цех» «не двигался», когда ОТК сканировал паспорт или
 * нажимал «Проверка выполнена».
 *
 * Backend сам проверит, что:
 *   - сотрудник на активной смене с операцией категории `QC`
 *     (иначе вернёт `SHIFT_SESSION_REQUIRED`);
 *   - паспорт «живой» (не `PACKED` / `CANCELLED`).
 *
 * Если `scanPassport` упал — карточку не открываем, чтобы фронт не
 * показал «принят», когда backend сказал «нельзя». Сообщение об
 * ошибке возвращается «как есть» из `ApiRequestError`.
 *
 * Идемпотентность гарантируется backend'ом: повторный скан того же
 * паспорта на той же операции тем же сотрудником —
 * no-op (`PassportsService.scanOnOperation`, ADR-0003 §6),
 * UI выглядит так же, как «ещё одно успешное принятие».
 *
 * RBAC: backend `/api/qc/passports/:id` отрежет роли, не имеющие
 * доступа к ОТК — повторно проверять в action не нужно.
 */
export async function lookupQcPassportAction(
  code: string,
): Promise<QcLookupResult> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { ok: false, error: 'Введите или отсканируйте код паспорта' };
  }
  try {
    const lookup = await findPassportByCode(trimmed);
    // Сначала пробуем «принять» паспорт на операцию ОТК — backend
    // в той же транзакции пишет OPERATION_SCAN и переключает
    // `passport.currentOperationId` на операцию категории QC. Это
    // двигает паспорт в bucket `QC` на shopfloor-проекции. Если
    // session ОТК нет (или паспорт CANCELLED) — здесь же прилетит
    // ошибка, и карточка не откроется.
    //
    // Retroactive QC для PACKED-паспортов: scan валит на
    // `PASSPORT_ALREADY_PACKED`, но карточку всё-таки открываем —
    // оператор сможет нажать «Проверка выполнена», backend пустит
    // (см. `QcService.completeQc`, ветка PACKED+no QC_PASSED).
    try {
      await scanPassport(lookup.id);
    } catch (e) {
      if (
        !(e instanceof ApiRequestError && e.code === 'PASSPORT_ALREADY_PACKED')
      ) {
        throw e;
      }
    }
    const detail = await getQcPassport(lookup.id);
    return { ok: true, detail };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

export type QcDetailRefreshResult =
  | { ok: true; detail: QcPassportDetailDto }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * Перечитать QC-карточку по passportId. Нужно после успешного
 * `recordDefectAction`/`completeQcAction`, чтобы в открытой карточке
 * сразу обновились qtyDefect/qtyGood/qcCompletedAt без перезагрузки
 * страницы.
 */
export async function refreshQcPassportAction(
  passportId: string,
): Promise<QcDetailRefreshResult> {
  try {
    const detail = await getQcPassport(passportId);
    return { ok: true, detail };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

export type QcCompleteResult =
  | { ok: true; detail: QcPassportDetailDto }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * QC role-terminal: «Проверка выполнена». Дёргаем
 * `POST /api/qc/passports/:id/complete` и инвалидируем те же кэши,
 * что и `recordDefectAction`.
 */
export async function completeQcAction(
  passportId: string,
): Promise<QcCompleteResult> {
  try {
    const detail = await completeQcPassport(passportId);
    revalidateForPassport(detail);
    return { ok: true, detail };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}
