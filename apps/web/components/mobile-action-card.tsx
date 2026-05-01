import Link from 'next/link';
import type { ReactNode } from 'react';

type Variant = 'default' | 'primary' | 'danger';

export interface MobileActionCardProps {
  href?: string;
  onClick?: () => void;
  title: string;
  hint?: string;
  icon?: ReactNode;
  variant?: Variant;
  disabled?: boolean;
  type?: 'button' | 'submit';
}

/**
 * MobileActionCard — крупная тач-карточка для главного меню /work
 * (см. mobile clean redesign, docs/ui-mobile.md). Сочетает иконку,
 * заголовок и подсказку. Может быть ссылкой, кнопкой или submit.
 */
export function MobileActionCard({
  href,
  onClick,
  title,
  hint,
  icon,
  variant = 'default',
  disabled,
  type = 'button',
}: MobileActionCardProps) {
  const cls = `action-card${variant !== 'default' ? ` action-card--${variant}` : ''}`;

  const body = (
    <>
      {icon ? <span className="action-card__icon">{icon}</span> : null}
      <span className="action-card__title">{title}</span>
      {hint ? <span className="action-card__hint">{hint}</span> : null}
    </>
  );

  if (href && !disabled) {
    return (
      <Link href={href} className={cls}>
        {body}
      </Link>
    );
  }

  return (
    <button
      type={type}
      className={cls}
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
    >
      {body}
    </button>
  );
}
