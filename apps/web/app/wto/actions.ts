'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import type { WtoPassportDetailDto } from '@sewing/shared/wto';
import { ApiRequestError } from '@/lib/api';
import { completeWtoPassport, getWtoPassport } from '@/lib/wto-api';
import { findPassportByCode, scanPassport } from '@/lib/shifts-api';

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

function revalidateForPassport(detail: WtoPassportDetailDto): void {
  revalidatePath('/wto');
  revalidatePath(`/passports/${detail.passportId}`);
  revalidatePath(`/admin/passports/${detail.passportId}`);
  revalidatePath(`/orders/${detail.orderId}`);
  revalidatePath(`/admin/orders/${detail.orderId}`);
  revalidateTag('cells');
}

// ---------------------------------------------------------------------------
// WTO role-terminal: scan-driven actions для `/wto` (см. `wto-terminal.tsx`)
// ---------------------------------------------------------------------------

export type WtoLookupResult =
  | { ok: true; detail: WtoPassportDetailDto }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * Резолв паспорта по произвольному коду (QR `passport:{id}`, номер
 * `P-…`, голый id), запуск входного `OPERATION_SCAN` на ВТО (через
 * общий `POST /api/passports/:id/scan`) и сразу загрузка
 * WTO-карточки. Полный аналог `lookupQcPassportAction`, но с одним
 * важным отличием: ВТО действительно «принимает» паспорт скан-сценарием,
 * поэтому здесь мы вызываем `scanPassport`. Backend сам проверит,
 * что:
 *   - сотрудник на активной смене с операцией категории `IRONING`
 *     (иначе вернёт `SHIFT_SESSION_REQUIRED` или общий бизнес-конфликт);
 *   - по паспорту есть `QC_PASSED` (иначе `PASSPORT_NOT_QC_PASSED`).
 *
 * Если `scanPassport` упал — карточку всё-таки не открываем, чтобы
 * фронт не показал «принят», когда backend сказал «нельзя». Сообщение
 * об ошибке возвращается «как есть» из `ApiRequestError`.
 *
 * Идемпотентность гарантируется backend'ом: повторный скан того же
 * паспорта на той же операции — no-op (`PassportsService.scanOnOperation`),
 * UI выглядит так же, как «ещё одно успешное принятие».
 */
export async function acceptOnWtoAction(
  code: string,
): Promise<WtoLookupResult> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { ok: false, error: 'Введите или отсканируйте код паспорта' };
  }
  try {
    const lookup = await findPassportByCode(trimmed);
    // Сначала пробуем «принять» — backend в ту же транзакцию пишет
    // OPERATION_SCAN и/или возвращает no-op (если паспорт уже на ВТО).
    // Если QC-gate сработает — здесь же прилетит ошибка, и карточка
    // не откроется.
    //
    // Retroactive WTO для PACKED-паспортов: scan валит на
    // `PASSPORT_ALREADY_PACKED`, но карточку всё-таки открываем —
    // оператор сможет нажать «Завершить ВТО», backend пустит
    // (см. `WtoService.completeWto`, ветка PACKED+no WTO_PASSED).
    try {
      await scanPassport(lookup.id);
    } catch (e) {
      if (
        !(e instanceof ApiRequestError && e.code === 'PASSPORT_ALREADY_PACKED')
      ) {
        throw e;
      }
    }
    const detail = await getWtoPassport(lookup.id);
    return { ok: true, detail };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

export type WtoDetailRefreshResult =
  | { ok: true; detail: WtoPassportDetailDto }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * Перечитать WTO-карточку по passportId. Используется поллером для
 * свернутой строки «ВТО завершено» и после `completeWtoAction` — чтобы
 * `wtoCompletedAt` обновился без перезагрузки страницы.
 */
export async function refreshWtoPassportAction(
  passportId: string,
): Promise<WtoDetailRefreshResult> {
  try {
    const detail = await getWtoPassport(passportId);
    return { ok: true, detail };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

export type WtoCompleteResult =
  | { ok: true; detail: WtoPassportDetailDto }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * WTO role-terminal: «Завершить ВТО». Дёргаем
 * `POST /api/wto/passports/:id/complete` и инвалидируем те же кэши,
 * что и `acceptOnWtoAction`.
 */
export async function completeWtoAction(
  passportId: string,
): Promise<WtoCompleteResult> {
  try {
    const detail = await completeWtoPassport(passportId);
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
