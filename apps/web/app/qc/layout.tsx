import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeEmployeeQrButton, canSeeQc } from '@/lib/rbac';
import { CallMasterButton } from '@/components/call-master-button';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';

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
  const showEmployeeQr = canSeeEmployeeQrButton(me.user.role);
  return (
    <>
      {children}
      {/*
       * «Мой QR-код» и «Мастер» закреплены СПРАВА вертикальным
       * столбиком (а не в нижних углах): низ экрана отдан закреплённой
       * панели действий ОТК (`.qc-card__sticky-actions`). Столбик
       * стоит ПОД три-точечным меню `.seamstress-actions` (тот же
       * top/right), чтобы его не перекрывать. Кнопки внутри —
       * icon-only 44×44 (см. `.qc-toolbar` в `globals.css`),
       * занимают минимум места, имя берётся из `aria-label`. Скоуп —
       * только `/qc`; на остальных терминалах кнопки остаются
       * FAB-ами с подписью в нижних углах.
       */}
      {showEmployeeQr || showMasterCall ? (
        <div className="qc-toolbar">
          {showEmployeeQr ? <EmployeeQrButton variant="floating" /> : null}
          {showMasterCall ? <CallMasterButton /> : null}
        </div>
      ) : null}
    </>
  );
}
