import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LogOut, ShieldCheck } from 'lucide-react';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeSuperadmin } from '@/lib/rbac';
import { logoutAction } from '@/app/(auth)/logout-action';

/**
 * Раздел супер-админа control-plane (мультитенантность, Фаза 4).
 *
 * Отдельный от `/admin` (тот тенант-скоупный): здесь управление РЕЕСТРОМ
 * тенантов. Доступ строго по роли `SUPERADMIN` (НЕ обычный ADMIN) — зеркалит
 * SuperadminGuard на бэкенде. Если control-plane выключен, API вернёт 404 на
 * запросах — страница покажет ошибку загрузки.
 *
 * Раскладка наследует `.admin-layout`, а глобальная шапка `<AppHeader>` под
 * этим классом скрыта (`body:has(.admin-layout) .app-header` в globals.css),
 * поэтому кнопка «Выйти» из шапки сюда не долетает — как и в `/admin`, где
 * logout живёт в сайдбаре. Здесь сайдбара нет, поэтому «Выйти» кладём в
 * топбар: `<form action={logoutAction}>` (server action), чтобы кнопка
 * работала без клиентского JS.
 */
export default async function SuperadminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/superadmin');
  if (!canSeeSuperadmin(me.user.roles ?? me.user.role)) redirect('/');
  return (
    <div className="admin-layout admin-layout--plain">
      <div className="admin-layout__content">
        <div className="superadmin-shell">
          <div className="superadmin-topbar">
            <ShieldCheck size={18} strokeWidth={1.6} aria-hidden />
            <Link href="/superadmin" className="superadmin-topbar__brand">
              Control-plane · Тенанты
            </Link>
            <span className="superadmin-topbar__user">{me.user.fullName}</span>
            <form action={logoutAction}>
              <button type="submit" className="superadmin-topbar__logout">
                <LogOut size={14} strokeWidth={1.6} aria-hidden />
                <span>Выйти</span>
              </button>
            </form>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
