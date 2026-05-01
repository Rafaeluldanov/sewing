import { NextRequest, NextResponse } from 'next/server';

/**
 * Лёгкая защита маршрутов (MVP 1.1, ADR-0014).
 *
 * Алгоритм:
 *   1. Если request на публичный путь (`/login`, `/api/health`,
 *      статика Next.js) — пропускаем без проверки.
 *   2. Иначе проверяем наличие session-cookie. Её содержимое здесь не
 *      разбираем как security gate (HMAC-валидация — на API-стороне в
 *      `AuthGuard`): middleware решает только «впускать ли вообще на
 *      страницу» и куда отправлять role-DISPLAY.
 *   3. Если cookie нет — редирект на `/login?next=<original>`.
 *   4. Если cookie есть и роль `DISPLAY` — пускаем только на
 *      `/shopfloor/display`, всё остальное редиректим туда же. Это
 *      реализует «один экран на всю учётку» большого монитора.
 *
 * Парсим payload session-cookie без проверки подписи: подделать роль
 * клиенту нечем (он не может выпустить себе cookie с `role: DISPLAY`,
 * не зная `JWT_SECRET`), а если кто-то вручную подменит cookie — в
 * худшем случае его «насильно» уведут на read-only display-экран,
 * а API всё равно отвергнет операции по реальным правам в `AuthGuard`.
 */
const SESSION_COOKIE_NAME = 'sewing_session';

const PUBLIC_PATH_PREFIXES = [
  '/login',
  '/_next',
  '/favicon',
  '/assets',
  '/api/health', // health-проксирование, если оно когда-нибудь появится в next
];

const DISPLAY_ROLE = 'DISPLAY';
const DISPLAY_PATH = '/shopfloor/display';

/**
 * Учётка мастера цеха (MVP) — у неё единственная осмысленная
 * страница `/master`, см. `apps/web/lib/rbac.ts`
 * (`SHOPFLOOR_MASTER_ALLOWED_PATH`). Логика та же, что у
 * `DISPLAY` — мягкий редирект на свой workspace, security всё
 * равно сидит в API-`AuthGuard`.
 */
const SHOPFLOOR_MASTER_ROLE = 'SHOPFLOOR_MASTER';
const SHOPFLOOR_MASTER_PATH = '/master';

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (
    PUBLIC_PATH_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    )
  ) {
    return NextResponse.next();
  }
  const cookie = req.cookies.get(SESSION_COOKIE_NAME);
  if (!cookie) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', `${pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(url);
  }

  // Soft-проверка роли: если это display-аккаунт, не пускаем на чужие
  // страницы. Парсинг payload без верификации подписи — этого достаточно
  // для UX-роутинга, security сидит в API-AuthGuard.
  const role = readRoleFromCookie(cookie.value);
  if (role === DISPLAY_ROLE && !isDisplayPath(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = DISPLAY_PATH;
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (
    role === SHOPFLOOR_MASTER_ROLE &&
    !isShopfloorMasterPath(pathname) &&
    !isApiPath(pathname)
  ) {
    const url = req.nextUrl.clone();
    url.pathname = SHOPFLOOR_MASTER_PATH;
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

function isDisplayPath(pathname: string): boolean {
  return pathname === DISPLAY_PATH || pathname.startsWith(`${DISPLAY_PATH}/`);
}

function isShopfloorMasterPath(pathname: string): boolean {
  return (
    pathname === SHOPFLOOR_MASTER_PATH ||
    pathname.startsWith(`${SHOPFLOOR_MASTER_PATH}/`)
  );
}

/**
 * `/api/*` проксируется на NestJS-бэкенд через next.config (rewrites).
 * Middleware не должен редиректить такие запросы — иначе fetch с
 * `/master` страницы (POST /api/master-calls/resolve-by-employee-qr,
 * etc.) у мастера цеха ушёл бы на саму себя через 307.
 */
function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Декодирует JSON-payload cookie без проверки подписи и возвращает
 * `role` (или `null`, если cookie не разбирается). Формат токена —
 * `base64url(json).base64url(sig)` (см. `apps/api/src/modules/auth/session.ts`).
 *
 * Edge runtime поддерживает `atob`, поэтому базовый base64 декодер
 * работает без `Buffer`.
 */
function readRoleFromCookie(token: string): string | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  try {
    const padded = body + '==='.slice((body.length + 3) % 4);
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64);
    const parsed: unknown = JSON.parse(json);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).role === 'string'
    ) {
      return (parsed as { role: string }).role;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Применяем middleware ко всем маршрутам, кроме статики Next и
 * favicon. Точная фильтрация (login и т.п.) — внутри функции выше.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
