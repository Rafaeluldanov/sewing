import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import {
  canSeeConstructor,
  canSeeEmployeeQrButton,
  getActiveWorkplaceLabel,
} from '@/lib/rbac';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';
import { TerminalShell } from '@/components/terminal-shell';

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
 *   - чип «Мой день» и «Мой QR-код» — боковой столбик
 *     `.employee-toolbar`. «Вызов мастера» конструктору не нужен (роль
 *     не цеховая), поэтому `CallMasterButton` здесь не рендерим.
 */
export default async function ConstructorSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/constructor');
  // Фича «несколько ролей»: доступ по всему набору ролей.
  const roles = me.user.roles ?? [me.user.role];
  if (!canSeeConstructor(roles)) redirect('/');

  const showEmployeeQr = canSeeEmployeeQrButton(roles);
  const roleLabel = getActiveWorkplaceLabel(me.user);

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
