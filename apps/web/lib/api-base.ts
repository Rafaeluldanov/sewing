/**
 * Единая точка получения базового URL API для web-приложения.
 *
 * Раньше fallback в `lib/config.ts` хардкодил `https://api.prod.teeon.ru/api`,
 * из-за чего на stage-окружении SSR пытался резолвить несуществующий хост
 * (`getaddrinfo ENOTFOUND api.prod.teeon.ru`) и Server Components падали.
 *
 * Теперь base URL вычисляется динамически из окружения:
 *
 * Server-side (RSC, server actions, API-routes):
 *   1. `INTERNAL_API_URL` — internal-адрес backend, обычно
 *      `http://127.0.0.1:3001/api`. Приоритетный, чтобы Next.js не ходил
 *      через публичный домен (это и быстрее, и не зависит от внешнего DNS).
 *   2. `API_URL` — обратная совместимость с предыдущей конфигурацией
 *      (`docs/deploy-stage.md`).
 *   3. `NEXT_PUBLIC_API_URL` — последний fallback, если на сервере
 *      выставлен только публичный URL.
 *   4. `http://127.0.0.1:3001/api` — дефолт для локальной разработки.
 *
 * Client-side (браузер):
 *   1. `NEXT_PUBLIC_API_URL` — единственный явный источник для клиента.
 *   2. `'/api'` — относительный путь, который nginx проксирует на backend
 *      на том же хосте (см. `docs/deploy-stage.md`). Безопасный fallback,
 *      который никогда не пытается уйти на чужой домен.
 */

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function pickEnv(...candidates: Array<string | undefined>): string | null {
  for (const v of candidates) {
    if (v && v.length > 0) return trimTrailingSlash(v);
  }
  return null;
}

/**
 * Возвращает базовый URL API, корректный для текущего окружения исполнения
 * (server vs client). См. описание модуля выше про порядок резолва.
 */
export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') {
    return (
      pickEnv(
        process.env.INTERNAL_API_URL,
        process.env.API_URL,
        process.env.NEXT_PUBLIC_API_URL,
      ) ?? 'http://127.0.0.1:3001/api'
    );
  }
  return pickEnv(process.env.NEXT_PUBLIC_API_URL) ?? '/api';
}
