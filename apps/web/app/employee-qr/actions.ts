'use server';

/**
 * Server action для кнопки «Мой QR-код»
 * (`apps/web/components/employees/employee-qr-button.tsx`).
 *
 * Клиентский компонент не может напрямую ходить в Nest API: сессионная
 * cookie HttpOnly, а `apiFetch` доступен только server-side (`cookies()`
 * из `next/headers`). Кнопка вызывает этот action, который и обращается
 * к `/api/me/employee-qr` через серверную обёртку
 * `apps/web/lib/employee-qr-api.ts`.
 *
 * Возвращаем единый `Result`-shape `{ ok: true, data } | { ok: false,
 * error, errorRequestId? }` — по тому же pattern'у, что server actions
 * модуля «Мастер цеха» (см. `apps/web/app/master/actions.ts`).
 */

import type { EmployeeQrResponseDto } from '@sewing/shared/employee-qr';
import { ApiRequestError } from '@/lib/api';
import { getMyEmployeeQrCode } from '@/lib/employee-qr-api';

export type GetMyEmployeeQrResult =
  | { ok: true; data: EmployeeQrResponseDto }
  | { ok: false; error: string; errorRequestId?: string };

export async function getMyEmployeeQrAction(): Promise<GetMyEmployeeQrResult> {
  try {
    const data = await getMyEmployeeQrCode();
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
  // Унифицированный текст из ТЗ; детализация (код/requestId) для
  // поддержки приходит через errorRequestId.
  if (e instanceof ApiRequestError) {
    if (e.code === 'EMPLOYEE_PROFILE_NOT_FOUND') {
      return 'К вашей учётной записи не привязан сотрудник.';
    }
    if (e.code === 'EMPLOYEE_INACTIVE') {
      return 'Сотрудник деактивирован.';
    }
    if (e.statusCode === 401 || e.code === 'UNAUTHENTICATED') {
      return 'Сессия истекла. Войдите заново.';
    }
  }
  return 'Не удалось загрузить QR-код. Попробуйте ещё раз.';
}
