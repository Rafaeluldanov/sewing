import type { ReactNode } from 'react';

/**
 * Контейнер экрана авторизации.
 *
 * Заполняет вьюпорт целиком, центрирует ребёнка по обеим осям, кладёт
 * мягкий фон из новых токенов (`--color-bg-soft`) и убирает безопасные
 * insets на iOS (`viewportFit: 'cover'` уже стоит в `app/layout.tsx`).
 *
 * Стили — в `apps/web/app/globals.css` секция «/login — Auth screen
 * (clean redesign)».
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return <div className="auth-screen">{children}</div>;
}
