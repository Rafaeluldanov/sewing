import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeAdmin } from '@/lib/rbac';
import {
  AdminSidebar,
  AdminSidebarMobileToggle,
} from '@/components/admin-sidebar';

/**
 * Route-level guard и общий layout для всех `/admin/*` страниц
 * (Admin UI 2.0).
 *
 * Доступ — `ADMIN` и `SHOP_MANAGER` (см. `docs/api.md §1`,
 * ADR-0017). Backend всё равно вернёт 403 на `/api/equipment/*` и
 * `/api/admin/*`, но без guard-а пользователь увидел бы пустую
 * страницу с ошибкой вместо понятного редиректа.
 *
 * Layout даёт двухколоночную раскладку: слева — `AdminSidebar`
 * (sticky, 240 px), справа — content. На ≤ 900 px sidebar
 * скрывается, и сверху появляется кнопка `AdminSidebarMobileToggle`,
 * которая раскрывает те же ссылки в виде drawer-а
 * (через нативный `<details>`, без client-state).
 *
 * Стили — `globals.css`, блок «Admin UI 2.0 — sidebar layout».
 * Override `.app-main` (max-width / padding) сделан тем же блоком
 * через `body:has(.admin-layout)`, чтобы не править глобальный
 * `.app-main` и не трогать `/master`, `/shopfloor`, `/work`.
 */
export default async function AdminSectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/admin');
  if (!canSeeAdmin(me.user.roles ?? me.user.role)) redirect('/');
  return (
    <div className="admin-layout">
      <AdminSidebar modules={me.modules} />
      <div className="admin-layout__content">
        <div className="admin-layout__mobile-bar">
          <AdminSidebarMobileToggle modules={me.modules} />
        </div>
        {children}
      </div>
    </div>
  );
}
