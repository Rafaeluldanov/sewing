import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { CallMasterButton } from '@/components/call-master-button';

/**
 * Section layout для `/work/*`.
 *
 * Существующая `/work/page.tsx` сама редиректит роли с другим
 * primary workspace (QC → /qc, IRONING → /wto, PACKING → /packing
 * — см. её комментарий и `apps/web/lib/rbac.ts`), поэтому здесь
 * мы только обеспечиваем наличие сессии и навешиваем кнопку
 * «Мастер» для рабочих ролей швейного контура (`SEAMSTRESS`,
 * `CUTTER`, `CUTTER_ASSISTANT`).
 *
 * Backend `/api/master-calls` всё равно отрежет лишних по
 * `@Roles(...)` — UI-флаг здесь только убирает кнопку из шапки
 * менеджера/админа, чтобы не сбивать их с толку.
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
  return (
    <>
      {children}
      {showMasterCall ? <CallMasterButton /> : null}
    </>
  );
}
