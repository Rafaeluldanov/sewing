import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeCutter, canSeeEmployeeQrButton } from '@/lib/rbac';
import { CallMasterButton } from '@/components/call-master-button';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';
import { TerminalShell } from '@/components/terminal-shell';

/** Подписи ролей для синей шапки-профиля. */
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
 * Раскладка — общий шаблон `TerminalShell` (`.work .work--seamstress`,
 * как у ОТК/ВТО/упаковки/швеи), глобальный `<AppHeader>` для `CUTTER`
 * на `/cutter` скрыт (см. `apps/web/components/app-header.tsx`):
 *   - синяя `RoleHeaderCard` (имя + роль) сверху; полей смены нет —
 *     раскрой не scan-shift роль;
 *   - меню «⋯ → Выйти» в углу карты (`showActionsMenu`, `shiftActive`
 *     не передаём → только «Выйти», без «Завершить смену»);
 *   - чип «Мой день», «Мой QR-код» и «Вызов мастера» — боковой столбик
 *     `.employee-toolbar` (раскройщику нужен полный набор, как швее/ОТК).
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
    <>
      <TerminalShell name={me.user.fullName} role={roleLabel} showActionsMenu>
        {children}
      </TerminalShell>
      <div className="employee-toolbar">
        <DailyEarningsChip />
        {showEmployeeQr ? <EmployeeQrButton variant="floating" /> : null}
        <CallMasterButton />
      </div>
    </>
  );
}
