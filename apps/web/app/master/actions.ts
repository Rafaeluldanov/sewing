'use server';

/**
 * Server actions модуля «Мастер цеха» (MVP).
 *
 * Контракт API — `apps/api/src/modules/master-calls/*`.
 * UI-потребители:
 *   - кнопка «Мастер» на рабочих экранах (`components/call-master-button.tsx`):
 *     `callMasterAction()` — идемпотентный POST.
 *   - мобильный экран `/master`:
 *     `refreshOpenMasterCallsAction()` — обновление очереди после
 *     закрытия вызова или периодического polling'а;
 *     `resolveMasterCallByEmployeeQrAction(qr)` — закрытие вызова
 *     сканом QR.
 *
 * Все три действия возвращают единый result-shape `{ ok: true, ... }
 * | { ok: false, error, errorRequestId? }` — UI обрабатывает их
 * одинаково и не должен ловить exceptions.
 */

import { revalidatePath } from 'next/cache';
import {
  ResolveMasterCallByQrSchema,
  type MasterCallDto,
} from '@sewing/shared/master-calls';
import { ApiRequestError } from '@/lib/api';
import {
  createMasterCall,
  listOpenMasterCalls,
  listRecentlyResolvedMasterCalls,
  resolveMasterCallById,
  resolveMasterCallByEmployeeQr,
} from '@/lib/master-calls-api';

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

export type CallMasterResult =
  | { ok: true; call: MasterCallDto }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * Кнопка «Мастер» на рабочих экранах. Идемпотентность гарантируется
 * backend'ом (`MasterCallsService.create`): если у сотрудника уже
 * есть `OPEN`-вызов — возвращается он же, новой строки в БД нет.
 *
 * Не блокирует работу: даже если backend временно недоступен, UI
 * получит `{ ok: false }` и просто покажет toast — основной flow
 * (сканы / завершение операций) продолжается.
 */
export async function callMasterAction(): Promise<CallMasterResult> {
  try {
    const call = await createMasterCall({});
    return { ok: true, call };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

export type MasterCallsListResult =
  | { ok: true; items: MasterCallDto[] }
  | { ok: false; error: string; errorRequestId?: string };

export async function refreshOpenMasterCallsAction(): Promise<MasterCallsListResult> {
  try {
    const items = await listOpenMasterCalls();
    return { ok: true, items };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

export type ResolveMasterCallResult =
  | { ok: true; call: MasterCallDto }
  | { ok: false; error: string; errorRequestId?: string };

export async function resolveMasterCallByEmployeeQrAction(
  qr: string,
): Promise<ResolveMasterCallResult> {
  const parsed = ResolveMasterCallByQrSchema.safeParse({ qr });
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        'Некорректный QR сотрудника (ожидается EMPLOYEE:<id>)',
    };
  }
  try {
    const call = await resolveMasterCallByEmployeeQr(parsed.data);
    revalidatePath('/master');
    return { ok: true, call };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Ручное закрытие вызова мастером по кнопке «Проблема решена» в
 * карточке (без QR). Возвращает обновлённый DTO, чтобы клиент мог
 * сразу переложить карточку в архив без повторного listing'а.
 */
export async function resolveMasterCallByIdAction(
  id: string,
): Promise<ResolveMasterCallResult> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Некорректный идентификатор вызова' };
  }
  try {
    const call = await resolveMasterCallById(id);
    revalidatePath('/master');
    return { ok: true, call };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

export async function refreshRecentlyResolvedMasterCallsAction(): Promise<MasterCallsListResult> {
  try {
    const items = await listRecentlyResolvedMasterCalls();
    return { ok: true, items };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}
