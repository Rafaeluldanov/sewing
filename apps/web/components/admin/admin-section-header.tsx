/**
 * AdminSectionHeader — заголовок секции внутри страницы админки.
 *
 * Стандартный layout: иконка + заголовок слева, опциональный hint
 * справа от заголовка, опциональные actions в правом краю. Не таскает
 * h1 — это для второго уровня (h2). Заголовок страницы рендерит
 * `<header class="admin-shell__header">` напрямую внутри страницы.
 */
import type { ReactNode } from 'react';

interface AdminSectionHeaderProps {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
}

export function AdminSectionHeader({
  icon,
  title,
  hint,
  actions,
}: AdminSectionHeaderProps) {
  return (
    <header className="admin-section-header">
      <h2 className="admin-section-header__title">
        {icon}
        {title}
        {hint != null && (
          <span className="admin-section-header__hint">{hint}</span>
        )}
      </h2>
      {actions != null && (
        <div className="admin-section-header__actions">{actions}</div>
      )}
    </header>
  );
}
