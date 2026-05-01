/**
 * AdminPageShell — единая обёртка любой страницы `/admin/*`
 * (Admin UI 2.5).
 *
 * Заменяет старую тройку `page-shell` + `page-title` + `page-subtitle`
 * (residue from pre-Admin-UI epoch) и одновременно — упрощённую
 * `admin-shell + admin-shell__header`. Один компонент, один стиль:
 *   - title 28–32px (`.admin-page-title`, см. `globals.css`);
 *   - subtitle короткий (1 строка), `.admin-muted`, 90 символов max;
 *   - icon в круглом плашке слева от заголовка;
 *   - actions справа (на mobile уезжают вниз);
 *   - под header'ом — children в стеке через `gap: --admin-space-lg`.
 *
 * Никаких длинных описаний, никакой meta-line, никаких back-link'ов
 * внутрь — навигация живёт в sidebar. Если страница — detail-карточка,
 * back-link рендерится отдельной ghost-кнопкой над shell или внутри
 * actions (см. `/admin/equipment/[id]`).
 */
import type { ReactNode } from 'react';

interface AdminPageShellProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export function AdminPageShell({
  title,
  subtitle,
  icon,
  actions,
  children,
}: AdminPageShellProps) {
  return (
    <div className="admin-page-shell">
      <header className="admin-page-shell__header">
        <div className="admin-page-shell__heading">
          {icon != null && (
            <span className="admin-page-shell__icon" aria-hidden>
              {icon}
            </span>
          )}
          <div className="admin-page-shell__title-block">
            <h1 className="admin-page-title">{title}</h1>
            {subtitle != null && (
              <p className="admin-page-shell__subtitle">{subtitle}</p>
            )}
          </div>
        </div>
        {actions != null && (
          <div className="admin-page-shell__actions">{actions}</div>
        )}
      </header>
      {children}
    </div>
  );
}
