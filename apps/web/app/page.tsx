import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { getDefaultRouteForRole } from '@/lib/role-redirect';

export const dynamic = 'force-dynamic';

/**
 * Корневой `/` после auth cleanup-а — это только редирект.
 * Подробнее в `docs/auth-design-cleanup-recon.md §3, §7`. Помимо
 * UX-аргумента, `getDefaultRouteForRole` для unknown / null роли
 * возвращает `/login`, а не `/` — так мы исключаем цикл редиректов.
 */
export default async function HomePage(): Promise<never> {
  const me = await getCurrentUserOrNull();
  if (!me) {
    redirect('/login');
  }
  redirect(getDefaultRouteForRole(me.user.role));
}
