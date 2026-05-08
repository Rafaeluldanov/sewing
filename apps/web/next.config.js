/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Используем TS-исходники shared-пакета напрямую, без билда
  // (см. README и packages/shared/package.json).
  transpilePackages: ['@sewing/shared'],
  experimental: {
    // Нужны для корректной работы серверных экшенов и fetch-кеша
    // при локальной разработке.
    serverActions: { allowedOrigins: [] },
  },

  // -------------------------------------------------------------------------
  // Прокси `/api/*` → backend (NestJS).
  //
  // Зачем: в браузер по дизайну (см. `lib/browser-api-paths.ts`) уходят
  // ОТНОСИТЕЛЬНЫЕ ссылки вида `/api/employees/:id/qr`, `/api/passports/:id/print`,
  // `<img src="/api/...">` и т.п. На prod это разруливает nginx, который
  // на одном домене раздаёт `web` и проксирует `/api/*` на `api:3001`.
  // В dev-стеке nginx нет — без этого rewrite браузер бы стучался на
  // `web:3000/api/...` и получал 404 от Next.js.
  //
  // Источник адреса backend — `INTERNAL_API_URL` (см. docker-compose.*.yml
  // и `apps/web/lib/api-base.ts`). По соглашению он уже содержит хвост
  // `/api`, поэтому снимаем его и подклеиваем обратно через `:path*` —
  // так одинаково работают и `INTERNAL_API_URL=http://api:3001/api`,
  // и `INTERNAL_API_URL=http://api:3001`.
  //
  // Внимание: в `apps/web/app/api` собственных Next.js-route-handler'ов
  // нет (специально), иначе этот rewrite их бы перехватил.
  // -------------------------------------------------------------------------
  async rewrites() {
    // Fallback. Docker-compose (docker-compose.dev.yml / .prod.yml)
    // ВСЕГДА задаёт INTERNAL_API_URL=http://api:3001/api явно, поэтому
    // на хост `api` (DNS docker network) рассчитывать в fallback нельзя:
    // при локальном `npm run dev:web` без docker такой fallback падает
    // с `getaddrinfo ENOTFOUND api`. Дефолт — http://localhost:3001/api,
    // соответствующий локальному `npm run dev:api` на :3001.
    const internal = process.env.INTERNAL_API_URL || 'http://localhost:3001/api';
    const apiOrigin = internal.replace(/\/api\/?$/, '');
    return [
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
    ];
  },
};

module.exports = nextConfig;
