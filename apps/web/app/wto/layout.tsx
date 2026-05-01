import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeWto } from '@/lib/rbac';

/**
 * Route-level guard для всего раздела `/wto/*`.
 *
 * Backend всё равно вернёт 403 на `/api/wto/*` (см. `WtoController`),
 * но без guard-а пользователь увидел бы пустую страницу с ошибкой
 * вместо понятного редиректа. Полный аналог `app/qc/layout.tsx`.
 *
 * Анонимы продолжают редиректиться `apps/web/middleware.ts` ещё до
 * рендера, так что здесь интересует только случай «вошёл, но не той
 * ролью».
 */
export default async function WtoSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/wto');
  if (!canSeeWto(me.user.role)) redirect('/');
  return <>{children}</>;
}
