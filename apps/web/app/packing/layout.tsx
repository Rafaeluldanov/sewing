import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeEmployeeQrButton, canSeePacking } from '@/lib/rbac';
import { CallMasterButton } from '@/components/call-master-button';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';

/**
 * Route-level guard для всего раздела `/packing/*` (включая
 * `/packing/boxes/[id]`).
 *
 * Backend режет `/api/packing/boxes` через `@Roles('PACKING',
 * 'SHOP_MANAGER')`; этот guard просто исключает «пустой экран с
 * ошибкой 403» и редиректит лишних пользователей на главную.
 */
export default async function PackingSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/packing');
  if (!canSeePacking(me.user.role)) redirect('/');
  const showMasterCall = me.user.role === 'PACKING';
  const showEmployeeQr = canSeeEmployeeQrButton(me.user.role);
  return (
    <>
      {children}
      {/*
       * Кнопки «Мой QR-код» и «Мастер» — единый вертикальный
       * столбик СПРАВА под три-точечным меню `.seamstress-actions`
       * (см. `.employee-toolbar` в `globals.css`). Идентичная
       * раскладка — на `/work`, `/qc`, `/wto`.
       */}
      {showEmployeeQr || showMasterCall ? (
        <div className="employee-toolbar">
          {showEmployeeQr ? <DailyEarningsChip /> : null}
          {showEmployeeQr ? <EmployeeQrButton variant="floating" /> : null}
          {showMasterCall ? <CallMasterButton /> : null}
        </div>
      ) : null}
    </>
  );
}
