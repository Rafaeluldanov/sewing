import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeQc } from '@/lib/rbac';

/**
 * Route-level guard для всего раздела `/qc/*`.
 *
 * Backend всё равно вернёт 403 на `/api/qc/*` (см. `QcController`),
 * но без guard-а пользователь увидел бы пустую страницу с ошибкой
 * вместо понятного редиректа. Сюда же попадают `/qc/passports/[id]`.
 *
 * Анонимы продолжают редиректиться `apps/web/middleware.ts` ещё до
 * рендера, так что здесь интересует только случай «вошёл, но не той
 * ролью».
 */
export default async function QcSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/qc');
  if (!canSeeQc(me.user.role)) redirect('/');
  return <>{children}</>;
}
