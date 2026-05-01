/**
 * Лёгкий fetch-клиент для общения с Nest API.
 *
 * Используется из серверных компонентов / server actions (см. `lib/config.ts`).
 * Клиентская сторона ходит через server actions, не вызывая `apiFetch`
 * напрямую — это даёт единое место для прокидывания session-cookie и
 * нормализации ошибок.
 *
 * Cookie-прокидывание (MVP 1.1, ADR-0014):
 *   Web и API могут жить на разных хостах (`prod.teeon.ru` vs
 *   `api.prod.teeon.ru`), поэтому браузер отдаёт session-cookie только
 *   web-серверу. SSR-вызов к API выполняется server-side и в browser
 *   контексте отсутствует — мы вручную читаем cookies из текущего
 *   запроса (`next/headers`) и форвардим их в API-fetch.
 */

import { cookies } from 'next/headers';
import { getServerApiUrl } from './config';

export interface ApiError {
  statusCode: number;
  message: string;
  code?: string;
  issues?: Array<{ path: string; message: string }>;
  /**
   * Сквозной идентификатор запроса (Шаг 12, Pilot Rollout).
   * API всегда отдаёт его в теле ошибки и заголовке `X-Request-Id`.
   * Сотрудник на пилоте называет это значение поддержке — и в логах
   * сразу находится нужная строка (см. `docs/api.md §13`).
   */
  requestId?: string;
}

export class ApiRequestError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly issues?: ApiError['issues'];
  readonly requestId?: string;

  constructor(payload: ApiError) {
    super(payload.message);
    this.statusCode = payload.statusCode;
    this.code = payload.code;
    this.issues = payload.issues;
    this.requestId = payload.requestId;
  }
}

interface ApiRequestInit extends Omit<RequestInit, 'body'> {
  body?: unknown;
  searchParams?: Record<string, string | number | undefined | null>;
  /** Next.js fetch cache policy. Для списков — `no-store`. */
  cache?: RequestCache;
  next?: { revalidate?: number | false; tags?: string[] };
  /** Если true, не форвардим session-cookie (для health/login probe). */
  skipAuth?: boolean;
  /**
   * Возвращать `null` вместо exception при `401 UNAUTHENTICATED`.
   * Удобно в layout/header: «не показывать пользователя» вместо ошибки.
   */
  returnNullOn401?: boolean;
}

export async function apiFetch<T>(
  path: string,
  init: ApiRequestInit = {},
): Promise<T> {
  const base = getServerApiUrl();
  const url = new URL(
    path.startsWith('/') ? path.slice(1) : path,
    `${base}/`,
  );
  if (init.searchParams) {
    for (const [k, v] of Object.entries(init.searchParams)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (!init.skipAuth) {
    const cookieHeader = readForwardCookie();
    if (cookieHeader) headers.cookie = cookieHeader;
  }
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: init.cache ?? 'no-store',
    next: init.next,
  });
  const text = await res.text();
  const payload: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (payload ?? {}) as Partial<ApiError>;
    if (res.status === 401 && init.returnNullOn401) {
      return null as T;
    }
    const headerRequestId = res.headers.get('x-request-id') ?? undefined;
    throw new ApiRequestError({
      statusCode: err.statusCode ?? res.status,
      message: err.message ?? res.statusText,
      code: err.code,
      issues: err.issues,
      requestId: err.requestId ?? headerRequestId,
    });
  }
  return payload as T;
}

/**
 * Multipart-вариант `apiFetch` для модулей с upload-эндпоинтами
 * (на MVP-1 — только «Лекала», `apps/web/lib/patterns-api.ts`).
 *
 * Главные отличия от `apiFetch`:
 *   - принимает готовый `FormData` (поле `file` + опциональные доп. поля),
 *     ничего не сериализует;
 *   - НЕ выставляет `content-type` руками — runtime сам добавит
 *     `multipart/form-data; boundary=...`;
 *   - всё остальное (cookie-форвардинг, разбор ошибок,
 *     `requestId`-header) такое же, как у обычного fetch-клиента.
 *
 * Делаем именно server-side: server actions Next.js собирают
 * `FormData` из client-form-а и форвардят сюда — нам не нужен
 * прямой POST из браузера в API через cross-origin (cookies всё
 * равно идут через Next.js host).
 */
export async function apiFetchMultipart<T>(
  path: string,
  formData: FormData,
  init: { method?: string; returnNullOn401?: boolean } = {},
): Promise<T> {
  const base = getServerApiUrl();
  const url = new URL(
    path.startsWith('/') ? path.slice(1) : path,
    `${base}/`,
  );
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  const cookieHeader = readForwardCookie();
  if (cookieHeader) headers.cookie = cookieHeader;
  const res = await fetch(url, {
    method: init.method ?? 'POST',
    headers,
    body: formData,
    cache: 'no-store',
  });
  const text = await res.text();
  const payload: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (payload ?? {}) as Partial<ApiError>;
    if (res.status === 401 && init.returnNullOn401) {
      return null as T;
    }
    const headerRequestId = res.headers.get('x-request-id') ?? undefined;
    throw new ApiRequestError({
      statusCode: err.statusCode ?? res.status,
      message: err.message ?? res.statusText,
      code: err.code,
      issues: err.issues,
      requestId: err.requestId ?? headerRequestId,
    });
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Сериализует все cookies из текущего HTTP-запроса в значение
 * заголовка `Cookie:`. Если мы не в request-context (background-job /
 * static build), `cookies()` бросит — глушим и возвращаем `null`.
 */
function readForwardCookie(): string | null {
  try {
    const all = cookies().getAll();
    if (all.length === 0) return null;
    return all.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return null;
  }
}
