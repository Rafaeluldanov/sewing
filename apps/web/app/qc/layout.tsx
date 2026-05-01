import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeQc } from '@/lib/rbac';
import { CallMasterButton } from '@/components/call-master-button';

/**
 * Route-level guard для всего раздела `/qc/*`.
 *
 * Backend всё равно вернёт 403 на `/api/qc/*` (см. `QcController`),
 * но без guard-а пользователь увидел бы пустую страницу с ошибкой
 * вместо понятного редиректа. Сюда же попадают `/qc/passports/[id]`.
 *
 * Анонимы продолжают редиректиться `apps/web/middleware.ts` ещё до
 * рендера, так что здесь интересует только случай «вошёл, но не той
 * ролью».
 */
export default async function QcSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/qc');
  if (!canSeeQc(me.user.role)) redirect('/');
  // Кнопка «Мастер» — только для роли терминала (`QC`). Менеджер /
  // админ заходит сюда наблюдательно и звать мастера со своих
  // экранов им не нужно (см. `docs/flows.md §«Вызов мастера»`,
  // backend `@Roles(...)` всё равно отрежет лишних).
  const showMasterCall = me.user.role === 'QC';
  return (
    <>
      {children}
      {showMasterCall ? <CallMasterButton /> : null}
    </>
  );
}
