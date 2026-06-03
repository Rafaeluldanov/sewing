import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeCutter, canSeeEmployeeQrButton } from '@/lib/rbac';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { LogoutButton } from '@/components/logout-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';

/**
 * Route-level guard для всего раздела `/cutter/*` (кабинет раскройщика).
 * Backend режет `/api/cutting-tasks/*` через `@Roles('CUTTER',
 * 'SHOP_MANAGER', 'ADMIN')`; этот guard убирает «пустой экран 403» и
 * редиректит лишних на главную.
 *
 * Раскладка действий сотрудника — как на остальных терминалах
 * (`/work`, `/qc`, `/wto`, `/packing`), глобальный `<AppHeader>` для
 * `CUTTER` на `/cutter` скрыт (см. `apps/web/components/app-header.tsx`):
 *   - «Выйти» — верхнее меню в правом верхнем углу (`.cabinet-topbar`),
 *     по модели три-точечного меню помощника раскройщика, но без
 *     «Завершить смену»;
 *   - чип «Мой день» (начисление) и «Мой QR-код» — боковой столбик
 *     `.employee-toolbar` справа. «Вызов мастера» здесь не нужен.
 */
export default async function CutterSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/cutter');
  if (!canSeeCutter(me.user.role)) redirect('/');

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
