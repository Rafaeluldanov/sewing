'use server';

/**
 * Server actions для виджета «Мой день» в кабинете сотрудника
 * (`apps/web/components/me/daily-earnings-chip.tsx` и его подкомпоненты).
 *
 * Возвращаем единый Result-shape `{ ok: true, data } | { ok: false,
 * error, errorRequestId? }` — тот же pattern, что в
 * `apps/web/app/employee-qr/actions.ts`.
 */

import type { MeDailyDto, MeHistoryDto } from '@sewing/shared/me-daily';
import { ApiRequestError } from '@/lib/api';
import { getMyDaily, getMyHistory } from '@/lib/me-api';

export type GetMyDailyResult =
  | { ok: true; data: MeDailyDto }
  | { ok: false; error: string; errorRequestId?: string };

export type GetMyHistoryResult =
  | { ok: true; data: MeHistoryDto }
  | { ok: false; error: string; errorRequestId?: string };

export async function getMyDailyAction(): Promise<GetMyDailyResult> {
  try {
    const data = await getMyDaily();
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: e instanceof ApiRequestError ? e.requestId : undefined,
    };
  }
}

export async function getMyHistoryAction(
  days = 30,
): Promise<GetMyHistoryResult> {
  try {
    const data = await getMyHistory(days);
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: e instanceof ApiRequestError ? e.requestId : undefined,
    };
  }
}

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.statusCode === 401 || e.code === 'UNAUTHENTICATED') {
      return 'Сессия истекла. Войдите заново.';
    }
    if (e.code === 'EMPLOYEE_PROFILE_NOT_FOUND') {
      return 'К вашей учётной записи не привязан сотрудник.';
    }
    if (e.code === 'EMPLOYEE_INACTIVE') {
      return 'Сотрудник деактивирован.';
    }
  }
  return 'Не удалось загрузить данные. Попробуйте ещё раз.';
}
