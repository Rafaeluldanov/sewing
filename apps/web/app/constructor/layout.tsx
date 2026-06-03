import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeConstructor, canSeeEmployeeQrButton } from '@/lib/rbac';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { LogoutButton } from '@/components/logout-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';

/**
 * Route-level guard для всего раздела `/constructor/*` (кабинет
 * конструктора). Backend режет `/api/constructor-tasks/*` через
 * `@Roles('CONSTRUCTOR', 'ADMIN', 'SHOP_MANAGER')`; этот guard убирает
 * «пустой экран 403» и редиректит лишних на главную.
 *
 * Раскладка действий — та же, что у остальных терминалов, глобальный
 * `<AppHeader>` для `CONSTRUCTOR` на `/constructor` скрыт (см.
 * `apps/web/components/app-header.tsx`):
 *   - «Выйти» — верхнее меню справа сверху (`.cabinet-topbar`);
 *   - чип «Мой день» (начисление) — боковой столбик `.employee-toolbar`.
 * «Мой QR-код» конструктору не показываем: роль не цеховая и в
 * производственном потоке не сканируется (см. `canSeeEmployeeQrButton`),
 * поэтому `showEmployeeQr` для неё `false`.
 */
export default async function ConstructorSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/constructor');
  if (!canSeeConstructor(me.user.role)) redirect('/');

  const showEmployeeQr = canSeeEmployeeQrButton(me.user.role);

  return (
    <div className="constructor-shell">
      <div className="cabinet-topbar">
        <LogoutButton />
      </div>
      <main className="constructor-shell__main">{children}</main>
      <div className="employee-toolbar">
        <DailyEarningsChip />
        {showEmployeeQr ? <EmployeeQrButton variant="floating" /> : null}
      </div>
    </div>
  );
}
