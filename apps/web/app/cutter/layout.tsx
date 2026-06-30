import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeCutter, canSeeEmployeeQrButton } from '@/lib/rbac';
import { getCurrentShift } from '@/lib/shifts-api';
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

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Route-level guard для всего раздела `/cutter/*` (кабинет раскройщика).
 * Backend режет `/api/cutting-tasks/*` через `@Roles('CUTTER',
 * 'SHOP_MANAGER', 'ADMIN')`; этот guard убирает «пустой экран 403» и
 * редиректит лишних на главную.
 *
 * Раскладка — общий шаблон `TerminalShell` (`.work .work--seamstress`,
 * как у ОТК/ВТО/упаковки/швеи), глобальный `<AppHeader>` для `CUTTER`
 * на `/cutter` скрыт (см. `apps/web/components/app-header.tsx`):
 *   - синяя `RoleHeaderCard` (имя + роль) сверху; при активной смене —
 *     поля операции/оборудования и статус «Смена с HH:MM» (раскрой —
 *     scan-shift роль: смена = табель + часы, см. `cutter/page.tsx`);
 *   - меню «⋯» в углу карты (`showActionsMenu`): при активной смене —
 *     «Завершить смену» + «Выйти», без смены — только «Выйти»;
 *   - чип «Мой день», «Мой QR-код» и «Вызов мастера» — боковой столбик
 *     `.employee-toolbar` (раскройщику нужен полный набор, как швее/ОТК).
 *
 * Текущую смену тянем здесь (а не только в `page.tsx`), потому что
 * `TerminalShell` с шапкой и меню живёт на уровне layout и оборачивает
 * также `/cutter/[id]`. fail-soft на `ApiRequestError`: временный сбой
 * `GET /shifts/current` не должен ронять весь раздел в экран ошибки.
 */
export default async function CutterSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/cutter');
  // Фича «несколько ролей»: доступ по всему набору ролей.
  const roles = me.user.roles ?? [me.user.role];
  if (!canSeeCutter(roles)) redirect('/');

  const showEmployeeQr = canSeeEmployeeQrButton(roles);
  const roleLabel = ROLE_LABELS[me.user.role] ?? me.user.role;

  let currentShift = null;
  try {
    currentShift = await getCurrentShift();
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
  }
  const isShiftActive = !!(currentShift && currentShift.active);
  const headerFields = isShiftActive
    ? [
        {
          label: 'Операция',
          value: currentShift!.operationName,
          meta: currentShift!.operationCode,
        },
        {
          label: 'Оборудование',
          value: currentShift!.equipmentName,
          meta: currentShift!.equipmentCode,
        },
      ]
    : [];

  return (
    <>
      <TerminalShell
        name={me.user.fullName}
        role={roleLabel}
        fields={headerFields}
        shiftActive={isShiftActive}
        statusText={
          isShiftActive
            ? `Смена с ${formatTime(currentShift!.startedAt)}`
            : 'Смена не начата — отсканируйте QR раскройного стола'
        }
        showActionsMenu
      >
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
