import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeConstructor, canSeeEmployeeQrButton } from '@/lib/rbac';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';
import { TerminalShell } from '@/components/terminal-shell';

/** Подписи ролей для синей шапки-профиля. */
const ROLE_LABELS: Record<string, string> = {
  CONSTRUCTOR: 'Конструктор',
  SHOP_MANAGER: 'Начальник цеха',
  ADMIN: 'Администратор',
};

/**
 * Route-level guard для всего раздела `/constructor/*` (кабинет
 * конструктора). Backend режет `/api/constructor-tasks/*` через
 * `@Roles('CONSTRUCTOR', 'ADMIN', 'SHOP_MANAGER')`; этот guard убирает
 * «пустой экран 403» и редиректит лишних на главную.
 *
 * Раскладка — общий шаблон `TerminalShell` (`.work .work--seamstress`,
 * как у ОТК/ВТО/упаковки/швеи), глобальный `<AppHeader>` для
 * `CONSTRUCTOR` на `/constructor` скрыт (см.
 * `apps/web/components/app-header.tsx`):
 *   - синяя `RoleHeaderCard` (имя + роль) сверху; полей смены нет —
 *     конструктор не scan-shift роль;
 *   - меню «⋯ → Выйти» в углу карты (`showActionsMenu`, `shiftActive`
 *     не передаём → только «Выйти», без «Завершить смену»);
 *   - чип «Мой день» — боковой столбик `.employee-toolbar`.
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
  const roleLabel = ROLE_LABELS[me.user.role] ?? me.user.role;

  return (
    <>
      <TerminalShell name={me.user.fullName} role={roleLabel} showActionsMenu>
        {children}
      </TerminalShell>
      <div className="employee-toolbar">
        <DailyEarningsChip />
        {showEmployeeQr ? <EmployeeQrButton variant="floating" /> : null}
      </div>
    </>
  );
}
