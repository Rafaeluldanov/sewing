import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeePacking } from '@/lib/rbac';

/**
 * Route-level guard для всего раздела `/packing/*` (включая
 * `/packing/boxes/[id]`).
 *
 * Backend режет `/api/packing/boxes` через `@Roles('PACKING',
 * 'SHOP_MANAGER')`; этот guard просто исключает «пустой экран с
 * ошибкой 403» и редиректит лишних пользователей на главную.
 */
export default async function PackingSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/packing');
  if (!canSeePacking(me.user.role)) redirect('/');
  return <>{children}</>;
}
