/**
 * AdminCard — основной строительный блок новой админки.
 *
 * Это тонкая обёртка над `<section class="admin-card">`. Никакого
 * состояния, никакой логики — только согласованный padding/border/
 * radius из дизайн-системы (`--admin-radius-card`,
 * `--admin-shadow-soft`).
 *
 * Если нужно сделать карточку кликабельной (вся целиком — ссылка), —
 * добавьте `href`, и компонент отрендерится как `<a class="admin-card
 * admin-card--clickable">`. Это нужно только для dashboard-карточек на
 * `/admin`; в обычных секциях используйте «обычный» вариант с
 * содержимым внутри.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';

interface AdminCardProps {
  children: ReactNode;
  className?: string;
  compact?: boolean;
  href?: string;
  ariaLabel?: string;
}

export function AdminCard({
  children,
  className,
  compact,
  href,
  ariaLabel,
}: AdminCardProps) {
  const cls = [
    'admin-card',
    compact ? 'admin-card--compact' : null,
    href ? 'admin-card--clickable' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  if (href) {
    return (
      <Link href={href} className={cls} aria-label={ariaLabel}>
        {children}
      </Link>
    );
  }
  return (
    <section className={cls} aria-label={ariaLabel}>
      {children}
    </section>
  );
}
