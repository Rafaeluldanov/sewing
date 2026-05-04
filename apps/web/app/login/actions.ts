'use server';

import { redirect } from 'next/navigation';
import { LoginRequestSchema } from '@sewing/shared/auth';
import { loginAndPersistSession } from '@/lib/auth-api';
import { safeReturnTo } from '@/lib/safe-return-to';

export interface LoginFormState {
  error?: string;
  code?: string;
}

/**
 * Server action логина. Сетевая часть и cookie-handling не меняются —
 * см. `loginAndPersistSession`. После успеха роутинг полностью
 * делегирован `safeReturnTo`:
 *   - если в FormData есть валидный относительный `next` (и он не
 *     ведёт обратно на /login) — уважаем его;
 *   - иначе — `getDefaultRouteForRole(role)` (см.
 *     `apps/web/lib/role-redirect.ts`).
 *
 * Это закрывает open-redirect surface (см.
 * `docs/auth-design-cleanup-recon.md §6`) и убирает старый
 * intermediate-экран на `/`: для ADMIN/SHOP_MANAGER `safeReturnTo`
 * вернёт `/admin`, минуя legacy dashboard.
 */
export async function loginAction(
  _prev: LoginFormState,
  form: FormData,
): Promise<LoginFormState> {
  const parsed = LoginRequestSchema.safeParse({
    login: String(form.get('login') ?? '').trim(),
    password: String(form.get('password') ?? ''),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  const result = await loginAndPersistSession(parsed.data);
  if (!result.ok) {
    return { error: result.message, code: result.code };
  }
  const next = String(form.get('next') ?? '');
  redirect(safeReturnTo(next, result.user.role));
}
