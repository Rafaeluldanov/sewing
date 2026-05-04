import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeEmployeeQrButton } from '@/lib/rbac';
import { CallMasterButton } from '@/components/call-master-button';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';

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
  const role = me.user.role;
  const showMasterCall =
    role === 'SEAMSTRESS' ||
    role === 'CUTTER' ||
    role === 'CUTTER_ASSISTANT';
  const showEmployeeQr = canSeeEmployeeQrButton(role);
  return (
    <>
      {children}
      {showEmployeeQr ? <EmployeeQrButton variant="floating" /> : null}
      {showMasterCall ? <CallMasterButton /> : null}
    </>
  );
}
