import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { safeReturnTo } from '@/lib/safe-return-to';
import { AuthShell } from '@/components/auth/auth-shell';
import { AuthCard } from '@/components/auth/auth-card';
import { LoginForm } from '@/components/auth/login-form';

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  searchParams: { next?: string; error?: string; reason?: string };
}

/**
 * Страница входа (`/login`).
 *
 * Если пользователь уже залогинен — сразу редиректим в нужный экран по
 * роли, опираясь на единый `safeReturnTo` (см.
 * `apps/web/lib/safe-return-to.ts` и `docs/auth-design-cleanup-recon.md
 * §7`). Это убирает мерцание формы при back-кнопке и полностью
 * закрывает open-redirect через `?next=…`.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const me = await getCurrentUserOrNull();
  if (me) {
    redirect(
      safeReturnTo(searchParams.next, me.user.role, me.user.workspace),
    );
  }
  // Для анонима `safeReturnTo` без роли вернул бы `/login` (fallback),
  // что нам не подходит — здесь нам нужен «честный» relative-путь либо
  // пустая строка, чтобы login action после успеха пошёл по
  // role-default. Делаем эту валидацию inline и узко.
  const nextForForm = sanitizeNextForAnon(searchParams.next);
  // Автовыход по бездействию приводит человека сюда сам. Без
  // объяснения форма входа посреди смены читается как «система
  // выбросила», и первым делом спрашивают у мастера, что сломалось.
  const idleLogout = searchParams.reason === 'idle';
  return (
    <AuthShell>
      <AuthCard>
        {idleLogout && (
          <p className="auth-screen__notice" role="status">
            Вы вышли из системы из-за бездействия. Смена, если она была
            открыта, не закрыта — войдите снова и продолжайте работу.
          </p>
        )}
        <LoginForm next={nextForForm} />
      </AuthCard>
    </AuthShell>
  );
}

function sanitizeNextForAnon(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '';
  if (trimmed.includes('://')) return '';
  if (trimmed === '/') return '';
  if (
    trimmed === '/login' ||
    trimmed.startsWith('/login/') ||
    trimmed.startsWith('/login?')
  ) {
    return '';
  }
  return trimmed;
}
