import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeAdmin } from '@/lib/rbac';

/**
 * Route-level guard для всех `/admin/*` страниц.
 *
 * Доступ — `ADMIN` и `SHOP_MANAGER` (см. `docs/api.md §1`,
 * ADR-0017). Backend всё равно вернёт 403 на `/api/equipment/*` и
 * `/api/admin/*`, но без guard-а пользователь увидел бы пустую
 * страницу с ошибкой вместо понятного редиректа.
 */
export default async function AdminSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/admin/overview');
  if (!canSeeAdmin(me.user.role)) redirect('/');
  return <>{children}</>;
}
