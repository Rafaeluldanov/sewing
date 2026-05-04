import type { ReactNode } from 'react';

/**
 * «Карточка» экрана авторизации: заголовок, подзаголовок, slot для
 * формы / loading / error состояний.
 *
 * Тексты по умолчанию из ТЗ зафиксированы здесь, чтобы их не нужно
 * было дублировать в каждой странице, использующей AuthShell:
 *   - title: «Вход в SEWING»;
 *   - subtitle: «Система управления швейным производством».
 *
 * Их можно переопределить пропсами, если когда-нибудь понадобится
 * другой auth-flow (восстановление пароля и т.п.) — но в текущей
 * задаче мы их не трогаем.
 */
export interface AuthCardProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
}

export function AuthCard({
  title = 'Вход в SEWING',
  subtitle = 'Система управления швейным производством',
  children,
}: AuthCardProps) {
  return (
    <section className="auth-screen__card" aria-labelledby="auth-screen-title">
      <header className="auth-screen__header">
        <span className="auth-screen__brand-mark" aria-hidden>
          S
        </span>
        <h1 id="auth-screen-title" className="auth-screen__title">
          {title}
        </h1>
        <p className="auth-screen__subtitle">{subtitle}</p>
      </header>
      <div className="auth-screen__body">{children}</div>
    </section>
  );
}
