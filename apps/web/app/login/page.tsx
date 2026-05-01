import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { getPrimaryWorkspace } from '@/lib/rbac';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  searchParams: { next?: string; error?: string };
}

/**
 * Страница входа (MVP 1.1, mobile clean redesign).
 *
 * Если пользователь уже залогинен — сразу редиректим на `next` (если
 * он есть и валиден) либо в primary workspace его роли. Это убирает
 * «мерцание» формы при возврате по back-кнопке и поддерживает
 * модель «одно рабочее окно на роль» (см. `apps/web/lib/rbac.ts`).
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const me = await getCurrentUserOrNull();
  if (me) {
    const explicit = safeNext(searchParams.next);
    redirect(explicit ?? getPrimaryWorkspace(me.user.role));
  }
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-card__brand">
          <span className="auth-card__brand-mark" aria-hidden>
            S
          </span>
          Sewing
        </div>
        <h1 className="auth-card__title">Вход в систему</h1>
        <p className="auth-card__hint">
          Введите ваш логин и пароль из справочника сотрудников.
          {' '}
          Demo-аккаунты после <code>npm run db:seed</code> используют
          {' '}
          пароль <code>Demo12345!</code>.
        </p>
        <LoginForm next={safeNext(searchParams.next) ?? ''} />
        <div className="auth-card__footer">
          <Link href="/">← На главную</Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Защита от open-redirect: разрешаем только явные относительные
 * пути, отличные от `/`. Корневой `/` трактуется как «нет явного
 * next» — дальше за выбор отвечает `getPrimaryWorkspace` (см.
 * `apps/web/app/login/actions.ts`).
 */
function safeNext(value: string | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return null;
  }
  if (value === '/') return null;
  return value;
}
