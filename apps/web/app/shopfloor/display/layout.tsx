import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeDisplayPage } from '@/lib/rbac';

/**
 * Route-level guard для `/shopfloor/display`.
 *
 * Доступ открыт ровно трём ролям (см. `DISPLAY_PAGE_ALLOWED_ROLES`):
 *   - `DISPLAY` — учётка большого монитора, единственная её страница;
 *   - `ADMIN` / `SHOP_MANAGER` — менеджер может посмотреть «как это
 *     выглядит на экране» с собственного устройства.
 *
 * Анонимы уже отсечены `apps/web/middleware.ts` редиректом на
 * `/login?next=...`, так что здесь интересует только «вошёл, но не
 * той ролью» — отправляем такую роль на её primary workspace через
 * корневой `/`.
 */
export default async function ShopfloorDisplayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/shopfloor/display');
  if (!canSeeDisplayPage(me.user.roles ?? me.user.role)) redirect('/');
  return <>{children}</>;
}
