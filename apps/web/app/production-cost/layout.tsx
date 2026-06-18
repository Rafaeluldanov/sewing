import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeProductionCost } from '@/lib/rbac';

/**
 * Route-level guard для `/production-cost`.
 *
 * Доступ — `ADMIN` и `SHOP_MANAGER` (см. `docs/screens.md §17`).
 * Backend независимо защищает `/api/costs/production` через
 * `@Roles('SHOP_MANAGER', 'ADMIN')`.
 */
export default async function ProductionCostLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/production-cost');
  if (!canSeeProductionCost(me.user.roles ?? me.user.role)) redirect('/');
  return <>{children}</>;
}
