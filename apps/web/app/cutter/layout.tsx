import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeCutter, canSeeEmployeeQrButton } from '@/lib/rbac';
import { CallMasterButton } from '@/components/call-master-button';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { LogoutButton } from '@/components/logout-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';

/**
 * Route-level guard для всего раздела `/cutter/*` (кабинет раскройщика).
 * Backend режет `/api/cutting-tasks/*` через `@Roles('CUTTER',
 * 'SHOP_MANAGER', 'ADMIN')`; этот guard убирает «пустой экран 403» и
 * редиректит лишних на главную.
 *
 * Шапки сверху нет: глобальный `<AppHeader>` для роли `CUTTER` на
 * `/cutter` скрыт (см. `apps/web/components/app-header.tsx`), как у
 * остальных рабочих терминалов (`/work`, `/qc`, `/wto`, `/packing`).
 * Вместо неё — боковой столбик `.employee-toolbar` справа: чип «Мой
 * день» (начисление), «Мой QR-код», «Вызов мастера» и «Выйти».
 */
export default async function CutterSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/cutter');
  if (!canSeeCutter(me.user.role)) redirect('/');

  const role = me.user.role;
  const showEmployeeQr = canSeeEmployeeQrButton(role);
  // Раскройщик вызывает мастера так же, как на `/work`.
  const showMasterCall = role === 'CUTTER';

  return (
    <div className="constructor-shell">
      <main className="constructor-shell__main">{children}</main>
      {/*
       * Единый правый столбик кнопок сотрудника — та же раскладка
       * `.employee-toolbar`, что на `/work`, `/qc`, `/wto`, `/packing`.
       * «Выйти» добавлен сюда же: у раскройщика нет терминального
       * трёхточечного меню (как у швеи), поэтому logout живёт в тулбаре.
       */}
      {showEmployeeQr || showMasterCall ? (
        <div className="employee-toolbar">
          {showEmployeeQr ? <DailyEarningsChip /> : null}
          {showEmployeeQr ? <EmployeeQrButton variant="floating" /> : null}
          {showMasterCall ? <CallMasterButton /> : null}
          <LogoutButton />
        </div>
      ) : null}
    </div>
  );
}
