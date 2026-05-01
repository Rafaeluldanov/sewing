'use server';

import { redirect } from 'next/navigation';
import { LoginRequestSchema } from '@sewing/shared/auth';
import { loginAndPersistSession } from '@/lib/auth-api';
import { getPrimaryWorkspace } from '@/lib/rbac';

export interface LoginFormState {
  error?: string;
  code?: string;
}

/**
 * Default-редирект после успешного входа.
 *
 * Если `next` не задан или указывает на корневой `/` (типичная
 * ситуация: пользователь зашёл на `/login` без явного редиректа),
 * отправляем сразу в primary workspace роли — швея и помощник
 * раскройщика попадают в `/work`, ОТК — в `/qc`, упаковка — в
 * `/packing`. Это ключевая часть модели «одно рабочее окно на
 * роль» (см. `apps/web/lib/rbac.ts`, `docs/screens.md §1`).
 *
 * Если `next` — валидный относительный путь, отличный от `/` (как
 * при middleware-редиректе с `?next=/orders`), уважаем его.
 */
function resolveLoginRedirect(rawNext: string, role: string): string {
  const next = rawNext.trim();
  const isRelative = next.startsWith('/') && !next.startsWith('//');
  if (!isRelative || next === '/') {
    return getPrimaryWorkspace(role);
  }
  return next;
}

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
  redirect(resolveLoginRedirect(next, result.user.role));
}
