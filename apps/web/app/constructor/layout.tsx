import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeConstructor } from '@/lib/rbac';
import { LogoutButton } from '@/components/logout-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';

/**
 * Route-level guard для всего раздела `/constructor/*` (кабинет
 * конструктора). Backend режет `/api/constructor-tasks/*` через
 * `@Roles('CONSTRUCTOR', 'ADMIN', 'SHOP_MANAGER')`; этот guard убирает
 * «пустой экран 403» и редиректит лишних на главную.
 *
 * Шапки сверху нет: глобальный `<AppHeader>` для роли `CONSTRUCTOR` на
 * `/constructor` скрыт (см. `apps/web/components/app-header.tsx`), как у
 * остальных single-workspace терминалов. Вместо неё — боковой столбик
 * `.employee-toolbar` справа. Конструктор не цеховая роль: «Вызов
 * мастера» и «Мой QR-код» ему не нужны, поэтому в столбике только чип
 * «Мой день» (начисление) и «Выйти».
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
      <main className="constructor-shell__main">{children}</main>
      <div className="employee-toolbar">
        <DailyEarningsChip />
        <LogoutButton />
      </div>
    </div>
  );
}
