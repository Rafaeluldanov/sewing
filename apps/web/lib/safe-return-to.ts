/**
 * Защита от open-redirect для post-login редиректа.
 *
 * Контракт:
 *   - принимаем сырой `returnTo` из query/form;
 *   - если он валидный относительный путь и не указывает обратно на
 *     `/login` — возвращаем как есть;
 *   - в остальных случаях — `getDefaultRouteForRole(role)` (а не `/`,
 *     чтобы избежать редирект-цикла).
 *
 * Что считаем «валидным относительным путём»:
 *   - `startsWith('/')` && `!startsWith('//')` — отбрасываем
 *     protocol-relative `//evil.com`, который браузер считает
 *     абсолютным URL на чужой хост;
 *   - не содержит `://` — отбрасываем абсолютные URL вида
 *     `https://evil.com`;
 *   - не равен и не начинается с `/login` — после успешного login
 *     возвращаться на login = редирект-цикл.
 *
 * Эта функция — UI safety net. Backend всё равно режет доступ через
 * `@Roles(...)`, но если returnTo нечестный, мы предпочтём показать
 * пользователю его собственный workspace, а не дать ему попасть на
 * чужой URL по своей сессии.
 */
import { getDefaultRouteForRole } from './role-redirect';

export function safeReturnTo(
  returnTo: string | null | undefined,
  role: string | null | undefined,
  /**
   * Рабочий экран из `/api/auth/me` (`AuthUserDto.workspace`). Нужен,
   * чтобы fallback для роли из справочника (`/admin/roles`) вёл на её
   * экран, а не на `/login`.
   */
  workspace?: string | null,
): string {
  const fallback = getDefaultRouteForRole(role, workspace);
  if (typeof returnTo !== 'string') return fallback;
  const trimmed = returnTo.trim();
  if (!trimmed) return fallback;
  if (!trimmed.startsWith('/')) return fallback;
  if (trimmed.startsWith('//')) return fallback;
  if (trimmed.includes('://')) return fallback;
  if (trimmed === '/') return fallback;
  // `/login`, `/login/`, `/login?next=...` — в любом виде не пускаем
  // обратно на login после успешной авторизации.
  if (trimmed === '/login' || trimmed.startsWith('/login/') || trimmed.startsWith('/login?')) {
    return fallback;
  }
  return trimmed;
}
