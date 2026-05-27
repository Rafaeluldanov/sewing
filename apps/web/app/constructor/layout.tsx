import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeConstructor } from '@/lib/rbac';
import { LogoutButton } from '@/components/logout-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';

/**
 * Route-level guard для всего раздела `/constructor/*` (кабинет
 * конструктора). Backend режет `/api/constructor-tasks/*` через
 * `@Roles('CONSTRUCTOR', 'ADMIN', 'SHOP_MANAGER')`; этот guard
 * исключает «пустой экран с ошибкой 403» и редиректит лишних
 * пользователей на главную.
 *
 * `<AppHeader>` для роли `CONSTRUCTOR` уже скрыт глобально через
 * `SINGLE_WORKSPACE_ROLES`. Здесь рисуем только свою лёгкую шапку
 * с именем + logout — этого достаточно, потому что navigation у
 * single-workspace роли не нужна.
 */
export default async function ConstructorSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/constructor');
  if (!canSeeConstructor(me.user.role)) redirect('/');

  return (
    <div className="constructor-shell">
      <header className="constructor-shell__header">
        <div>
          <div className="constructor-shell__brand">Sewing · Конструктор</div>
          <div className="constructor-shell__name">{me.user.fullName}</div>
        </div>
        <div className="constructor-shell__header-actions">
          <DailyEarningsChip className="my-day-chip--inline" />
          <LogoutButton />
        </div>
      </header>
      <main className="constructor-shell__main">{children}</main>
    </div>
  );
}
