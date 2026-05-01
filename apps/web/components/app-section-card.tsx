import type { ReactNode } from 'react';

export interface AppSectionCardProps {
  title?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * AppSectionCard — лёгкая контентная секция для сборных мобильных
 * экранов: серый фон, скругления, опциональный заголовок и хинт.
 * Используется в /work, /passports/[id] и подобных карточках.
 */
export function AppSectionCard({ title, hint, children, className }: AppSectionCardProps) {
  return (
    <section className={`section-card${className ? ` ${className}` : ''}`}>
      {title ? <h2 className="section-card__title">{title}</h2> : null}
      {hint ? <p className="section-card__hint">{hint}</p> : null}
      {children}
    </section>
  );
}
