import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeCutter } from '@/lib/rbac';
import { LogoutButton } from '@/components/logout-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';

/**
 * Route-level guard для всего раздела `/cutter/*` (кабинет раскройщика).
 * Backend режет `/api/cutting-tasks/*` через `@Roles('CUTTER',
 * 'SHOP_MANAGER', 'ADMIN')`; этот guard исключает «пустой экран 403» и
 * редиректит лишних пользователей на главную.
 *
 * `<AppHeader>` для роли `CUTTER` скрыт глобально (single-workspace).
 * Рисуем лёгкую шапку с именем + logout — навигация single-workspace
 * роли не нужна.
 */
export default async function CutterSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/cutter');
  if (!canSeeCutter(me.user.role)) redirect('/');

  return (
    <div className="constructor-shell">
      <header className="constructor-shell__header">
        <div>
          <div className="constructor-shell__brand">Sewing · Раскрой</div>
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
