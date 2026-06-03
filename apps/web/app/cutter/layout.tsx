import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeCutter, canSeeEmployeeQrButton } from '@/lib/rbac';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';
import { RoleHeaderCard } from '@/components/role-header-card';
import { SeamstressActionsMenu } from '@/app/work/seamstress-actions-menu';

/** Подписи ролей для синей шапки-профиля (см. ниже). */
const ROLE_LABELS: Record<string, string> = {
  CUTTER: 'Раскройщик',
  SHOP_MANAGER: 'Начальник цеха',
  ADMIN: 'Администратор',
};

/**
 * Route-level guard для всего раздела `/cutter/*` (кабинет раскройщика).
 * Backend режет `/api/cutting-tasks/*` через `@Roles('CUTTER',
 * 'SHOP_MANAGER', 'ADMIN')`; этот guard убирает «пустой экран 403» и
 * редиректит лишних на главную.
 *
 * Раскладка как на остальных терминалах (`/work`, `/qc`, `/wto`,
 * `/packing`), глобальный `<AppHeader>` для `CUTTER` на `/cutter` скрыт
 * (см. `apps/web/components/app-header.tsx`):
 *   - синяя шапка-профиль `RoleHeaderCard` (имя + роль) сверху — как в
 *     ОТК; полей смены нет (раскрой не scan-shift роль);
 *   - «Выйти» — то же три-точечное меню `SeamstressActionsMenu`, что у
 *     помощника раскройщика, поверх угла карты; `shiftActive={false}`
 *     убирает «Завершить смену», остаётся только «Выйти»;
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
  const roleLabel = ROLE_LABELS[me.user.role] ?? me.user.role;

  return (
    <div className="constructor-shell">
      <main className="constructor-shell__main">
        <SeamstressActionsMenu shiftActive={false} />
        <RoleHeaderCard name={me.user.fullName} role={roleLabel} />
        {children}
      </main>
      <div className="employee-toolbar">
        <DailyEarningsChip />
        {showEmployeeQr ? <EmployeeQrButton variant="floating" /> : null}
      </div>
    </div>
  );
}
