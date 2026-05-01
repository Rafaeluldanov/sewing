/**
 * Серверные обёртки для модуля Auth (MVP 1.1, ADR-0014).
 *
 * Предназначены для использования в RSC и server actions. Клиентские
 * компоненты ходят сюда через server actions, а не напрямую — это
 * единственный способ безопасно установить session-cookie.
 */

import { cookies, headers } from 'next/headers';
import { z } from 'zod';
import {
  type LoginRequestDto,
  type LoginResponseDto,
  type MeResponseDto,
} from '@sewing/shared/auth';
import { apiFetch, ApiRequestError } from './api';

/**
 * Минимальная runtime-валидация ответа `POST /api/auth/login`.
 * В `packages/shared/src/auth.ts` контракт описан только как
 * TypeScript-интерфейс (`LoginResponseDto`), zod-схемы для ответа нет —
 * поэтому, чтобы не делать unsafe cast `payload as LoginResponseDto`,
 * локально проверяем форму `payload.user` через safeParse.
 */
const LoginResponseShape = z.object({
  user: z.object({
    id: z.string(),
    login: z.string(),
    fullName: z.string(),
    role: z.string(),
  }),
});

export const SESSION_COOKIE_NAME = 'sewing_session';

/**
 * Возвращает текущего пользователя или `null`, если сессии нет /
 * она невалидна. Используется в layout, чтобы показать ФИО/выход
 * без падения.
 */
export async function getCurrentUserOrNull(): Promise<MeResponseDto | null> {
  return apiFetch<MeResponseDto | null>('/auth/me', {
    returnNullOn401: true,
  });
}

/**
 * Делает запрос на login и форвардит `Set-Cookie` от API в Next-cookie store.
 * Возвращает либо `{ ok: true, user }`, либо `{ ok: false, message, code }`.
 *
 * Делаем `fetch` руками (не через `apiFetch`), потому что нам нужно
 * прочитать `Set-Cookie` заголовок ответа — `apiFetch` его теряет.
 */
export async function loginAndPersistSession(
  body: LoginRequestDto,
): Promise<
  | { ok: true; user: LoginResponseDto['user'] }
  | { ok: false; message: string; code?: string }
> {
  const { getServerApiUrl } = await import('./config');
  const url = `${getServerApiUrl()}/auth/login`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (e) {
    return {
      ok: false,
      message: `API недоступен: ${(e as Error).message}`,
      code: 'NETWORK',
    };
  }

  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }

  if (!res.ok) {
    return {
      ok: false,
      message:
        (payload.message as string) ?? res.statusText ?? 'Не удалось войти',
      code: payload.code as string | undefined,
    };
  }

  // Прокидываем session-cookie в Next-store: вычленяем именно нашу
  // cookie из `Set-Cookie` (там может быть несколько значений). Мы НЕ
  // дублируем все атрибуты — Next.js пишет cookie на свой web-host,
  // а не на api.host: достаточно value, expires/maxAge и базовых
  // флагов.
  const setCookie = collectSetCookie(res.headers);
  const session = pickCookie(setCookie, SESSION_COOKIE_NAME);
  if (!session) {
    return {
      ok: false,
      message: 'API не вернул session-cookie',
      code: 'NO_SESSION_COOKIE',
    };
  }
  const parsed = LoginResponseShape.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'API вернул некорректный ответ login',
      code: 'BAD_RESPONSE',
    };
  }
  const isHttps = headers().get('x-forwarded-proto') === 'https';
  cookies().set({
    name: SESSION_COOKIE_NAME,
    value: session.value,
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    path: '/',
    maxAge: session.maxAge ?? 12 * 60 * 60,
  });
  const user: LoginResponseDto['user'] = parsed.data.user;
  return { ok: true, user };
}

/**
 * Зовёт `POST /api/auth/logout` (форвардит cookie, чтобы API мог их
 * затереть на своём домене), и сразу удаляет cookie на стороне Next.
 */
export async function logoutAndClearSession(): Promise<void> {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch (e) {
    // Logout идемпотентен — даже если API недоступен или вернул 401,
    // мы всё равно затрём локальную cookie.
    if (!(e instanceof ApiRequestError)) throw e;
  }
  cookies().delete(SESSION_COOKIE_NAME);
}

interface ParsedSetCookie {
  name: string;
  value: string;
  maxAge?: number;
}

function pickCookie(
  cookies: ParsedSetCookie[],
  name: string,
): ParsedSetCookie | null {
  return cookies.find((c) => c.name === name) ?? null;
}

function collectSetCookie(h: Headers): ParsedSetCookie[] {
  // Headers.getSetCookie не работает в node-fetch < 18, но Next 14
  // на Node 20 уже его поддерживает.
  const raw =
    typeof (h as Headers & { getSetCookie?: () => string[] }).getSetCookie ===
    'function'
      ? (h as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : h.get('set-cookie')
        ? [h.get('set-cookie') as string]
        : [];
  return raw.map(parseSetCookie).filter((c): c is ParsedSetCookie => c !== null);
}

function parseSetCookie(line: string): ParsedSetCookie | null {
  const [pair, ...attrs] = line.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  let maxAge: number | undefined;
  for (const attr of attrs) {
    const [k, v] = attr.split('=').map((s) => s.trim());
    if (k.toLowerCase() === 'max-age' && v) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) maxAge = n;
    }
  }
  return { name, value, maxAge };
}
