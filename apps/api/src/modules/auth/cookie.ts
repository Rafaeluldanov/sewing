/**
 * Конфигурация cookie сессии и парсинг `Cookie:` заголовка.
 *
 * Принципы:
 *   - HttpOnly всегда. Токен сессии не должен быть доступен JS на клиенте.
 *   - `Secure` и `Domain=.teeon.ru` включаются автоматически по `APP_URL`,
 *     чтобы prod (`prod.teeon.ru`) и API (`api.prod.teeon.ru`) шарили cookie.
 *     В dev (`localhost`) `Secure` и `Domain` не выставляем — иначе браузер
 *     не сохранит куку.
 *   - `SameSite=Lax` — баланс между защитой от CSRF и удобством навигации.
 *
 * Формат хранения — см. `./session.ts`.
 */

export const SESSION_COOKIE_NAME = 'sewing_session';

export interface CookieAttributes {
  httpOnly: true;
  sameSite: 'lax' | 'strict' | 'none';
  secure: boolean;
  domain?: string;
  path: string;
  maxAge: number;
  expires?: Date;
}

export function buildSessionCookieAttributes(args: {
  appUrl?: string | null;
  ttlSeconds: number;
  expires?: Date;
}): CookieAttributes {
  const { domain, secure } = deriveDomainAndSecure(args.appUrl ?? null);
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    domain,
    path: '/',
    maxAge: args.ttlSeconds,
    expires: args.expires,
  };
}

/**
 * Сериализует cookie в значение заголовка `Set-Cookie`. Не используем
 * стороннюю зависимость (`cookie`/`set-cookie-parser`) — формат RFC 6265
 * простой, и нам достаточно ровно того, что мы здесь генерируем.
 */
export function serializeCookie(
  name: string,
  value: string,
  attrs: CookieAttributes,
): string {
  const parts: string[] = [`${name}=${value}`];
  if (attrs.maxAge > 0) parts.push(`Max-Age=${Math.floor(attrs.maxAge)}`);
  if (attrs.expires) parts.push(`Expires=${attrs.expires.toUTCString()}`);
  if (attrs.domain) parts.push(`Domain=${attrs.domain}`);
  parts.push(`Path=${attrs.path}`);
  if (attrs.httpOnly) parts.push('HttpOnly');
  if (attrs.secure) parts.push('Secure');
  parts.push(`SameSite=${capitalizeSameSite(attrs.sameSite)}`);
  return parts.join('; ');
}

export function serializeClearCookie(name: string, attrs: CookieAttributes): string {
  return serializeCookie(name, '', {
    ...attrs,
    maxAge: 0,
    expires: new Date(0),
  });
}

/**
 * Минимальный парсер `Cookie:` заголовка. NestJS из коробки не
 * парсит cookies, а тащить `cookie-parser` ради одного значения
 * избыточно.
 */
export function parseCookieHeader(
  header: string | undefined | null,
): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const piece of header.split(';')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (!name) continue;
    out[name] = decodeCookieValue(value);
  }
  return out;
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function capitalizeSameSite(v: 'lax' | 'strict' | 'none'): string {
  return v.charAt(0).toUpperCase() + v.slice(1);
}

interface DerivedAttrs {
  domain?: string;
  secure: boolean;
}

/**
 * Если `APP_URL` явно прод/stage (https), включаем `Secure`. Если он
 * указывает на `*.teeon.ru` — выставляем `Domain=.teeon.ru`, чтобы
 * cookie работала на UI (`prod.teeon.ru`) и на API (`api.prod.teeon.ru`).
 * Для локального dev оставляем cookie host-only без `Secure`.
 */
export function deriveDomainAndSecure(appUrl: string | null): DerivedAttrs {
  if (!appUrl) return { secure: false };
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
  } catch {
    return { secure: false };
  }
  const secure = parsed.protocol === 'https:';
  const host = parsed.hostname;
  if (!secure) return { secure: false };
  // Cookie-домен должен начинаться с точки для всех поддоменов.
  // `prod.teeon.ru` / `stage.teeon.ru` / `api.prod.teeon.ru` → `.teeon.ru`.
  if (host.endsWith('.teeon.ru') || host === 'teeon.ru') {
    return { secure: true, domain: '.teeon.ru' };
  }
  return { secure: true };
}
