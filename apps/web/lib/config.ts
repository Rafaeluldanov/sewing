/**
 * Конфигурация фронта.
 *
 * Базовый URL API резолвится через `lib/api-base.ts` — там единый порядок
 * приоритетов (`INTERNAL_API_URL` → `API_URL` → `NEXT_PUBLIC_API_URL` →
 * `http://127.0.0.1:3001/api` на сервере; `NEXT_PUBLIC_API_URL` → `/api`
 * в браузере). Здесь оставлены тонкие обёртки, чтобы не ломать существующие
 * импорты `getServerApiUrl` / `getClientApiUrl`.
 *
 * Доменная стратегия (см. `docs/index.md` / README):
 *
 *   - UI production:  https://prod.teeon.ru
 *   - API production: https://api.prod.teeon.ru
 *   - stage:          https://stage.teeon.ru
 *
 * В dev достаточно прописать в `.env`:
 *   INTERNAL_API_URL=http://127.0.0.1:3001/api
 *   NEXT_PUBLIC_API_URL=http://localhost:3001/api
 */

import { DOMAIN_PROD_WEB } from '@sewing/shared/config';
import { getApiBaseUrl } from './api-base';

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Базовый URL API для серверных компонентов / server actions.
 *
 * Оставлен ради обратной совместимости — внутри делегирует
 * `getApiBaseUrl()`, который сам понимает контекст исполнения.
 */
export function getServerApiUrl(): string {
  return getApiBaseUrl();
}

/**
 * Базовый URL API для клиентских компонентов.
 *
 * Делегирует `getApiBaseUrl()`. Может вернуть относительный `/api`,
 * если `NEXT_PUBLIC_API_URL` не задан, — это безопасный дефолт для
 * single-host деплоя (nginx проксирует `/api/` на backend).
 */
export function getClientApiUrl(): string {
  return getApiBaseUrl();
}

export function getAppUrl(): string {
  const fromEnv = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (fromEnv && fromEnv.length > 0) return trimTrailingSlash(fromEnv);
  return DOMAIN_PROD_WEB;
}
