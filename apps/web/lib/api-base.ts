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
 *   1. `NEXT_PUBLIC_API_URL` — единственный явный источник для клиента,
 *      НО только если страница открыта на том же хосте, что и он.
 *      Мультитенантность резолвит тенанта по `Host` (control-plane,
 *      `TenantDomain`), а в bundle вшит один абсолютный URL
 *      (`https://prod.teeon.ru/api`, см. `docker-compose.prod.yml`).
 *      Со страницы `expo.teeon.ru` такой fetch уходил бы на хост
 *      другого тенанта: JWT привязан к `tid`, API отвечает 401 — и
 *      всё, что опрашивает API с клиента (`/shopfloor/display`,
 *      «Схема стенда» по заказу), на любом тенанте кроме дефолтного
 *      живёт только первым SSR-кадром. Поэтому чужой хост → п. 2.
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
  const configured = pickEnv(process.env.NEXT_PUBLIC_API_URL);
  if (configured && isSameHost(configured, window.location)) return configured;
  return '/api';
}

/**
 * `true`, если абсолютный `url` ведёт на тот же host[:port], что и
 * текущая страница. Относительный `url` (`/api`) — всегда «свой».
 * Невалидный URL считаем чужим: лучше безопасный `/api`, чем запрос
 * неизвестно куда.
 */
function isSameHost(url: string, loc: { host: string; origin: string }): boolean {
  if (url.startsWith('/')) return true;
  try {
    return new URL(url, loc.origin).host === loc.host;
  } catch {
    return false;
  }
}
