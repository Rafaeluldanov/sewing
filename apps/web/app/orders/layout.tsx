import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeOrders } from '@/lib/rbac';

/**
 * Route-level guard для всего раздела `/orders/*`.
 *
 * Доступ — `ADMIN`, `SHOP_MANAGER`, плюс `CUTTER_ASSISTANT` (нужен
 * read-режим, чтобы помощник раскройщика мог дойти до
 * `/orders/[id]/passports/new` и выпустить паспорт). Все
 * остальные роли редиректятся на главную.
 *
 * Backend независимо от UI режет `/api/orders/*` через `@Roles(...)`
 * на `OrdersController` и `OrderPassportsController`.
 */
export default async function OrdersSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/orders');
  if (!canSeeOrders(me.user.role)) redirect('/');
  return <>{children}</>;
}
