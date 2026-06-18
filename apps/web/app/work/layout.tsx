import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeEmployeeQrButton } from '@/lib/rbac';
import { CallMasterButton } from '@/components/call-master-button';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { DailyEarningsChip } from '@/components/me/daily-earnings-chip';

/**
 * Section layout для `/work/*`.
 *
 * Существующая `/work/page.tsx` сама редиректит роли с другим
 * primary workspace (QC → /qc, IRONING → /wto, PACKING → /packing
 * — см. её комментарий и `apps/web/lib/rbac.ts`), поэтому здесь
 * мы только обеспечиваем наличие сессии и навешиваем кнопки
 * «Мастер» (для рабочих ролей) и «Мой QR-код» (для всех, у кого
 * `canSeeEmployeeQrButton`, кроме DISPLAY — он сюда и не попадает).
 *
 * Backend `/api/master-calls` и `/api/me/employee-qr` всё равно
 * отрежут лишних по `@Roles(...)` / `AuthGuard` — UI-флаги здесь
 * только убирают кнопки из шапки менеджера/админа, чтобы не сбивать
 * их с толку.
 */
export default async function WorkSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/work');
  // Фича «несколько ролей»: считаем по всему набору ролей.
  const roles = me.user.roles ?? [me.user.role];
  const showMasterCall =
    roles.includes('SEAMSTRESS') ||
    roles.includes('CUTTER') ||
    roles.includes('CUTTER_ASSISTANT');
  const showEmployeeQr = canSeeEmployeeQrButton(roles);
  return (
    <>
      {children}
      {/*
       * Кнопки «Мой QR-код» и «Мастер» — единый вертикальный
       * столбик СПРАВА под три-точечным меню `.seamstress-actions`
       * (см. `.employee-toolbar` в `globals.css`). Идентичная
       * раскладка — на `/qc`, `/wto`, `/packing`.
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
