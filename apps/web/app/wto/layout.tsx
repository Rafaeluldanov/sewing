import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeEmployeeQrButton, canSeeWto } from '@/lib/rbac';
import { CallMasterButton } from '@/components/call-master-button';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';

/**
 * Route-level guard для всего раздела `/wto/*`.
 *
 * Backend всё равно вернёт 403 на `/api/wto/*` (см. `WtoController`),
 * но без guard-а пользователь увидел бы пустую страницу с ошибкой
 * вместо понятного редиректа. Полный аналог `app/qc/layout.tsx`.
 *
 * Анонимы продолжают редиректиться `apps/web/middleware.ts` ещё до
 * рендера, так что здесь интересует только случай «вошёл, но не той
 * ролью».
 */
export default async function WtoSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/wto');
  // Фича «несколько ролей»: доступ по всему набору ролей.
  const roles = me.user.roles ?? [me.user.role];
  if (!canSeeWto(roles)) redirect('/');
  const showMasterCall = roles.includes('IRONING');
  const showEmployeeQr = canSeeEmployeeQrButton(roles);
  return (
    <>
      {children}
      {/*
       * Кнопки «Мой QR-код» и «Мастер» — единый вертикальный
       * столбик СПРАВА под три-точечным меню `.seamstress-actions`
       * (см. `.employee-toolbar` в `globals.css`). Идентичная
       * раскладка — на `/work`, `/qc`, `/packing`.
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
