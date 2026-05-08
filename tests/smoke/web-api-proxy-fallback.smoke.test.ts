/**
 * Smoke-guard: локальный `npm run dev:web` (без docker) не должен по
 * умолчанию проксировать `/api/*` на хост `api:3001`.
 *
 * Контекст:
 *   `apps/web/next.config.js` берёт backend-адрес из `INTERNAL_API_URL`
 *   и в rewrite перенаправляет туда `/api/:path*`. Хост `api` существует
 *   только внутри docker-compose-сети (см. `docker-compose.dev.yml`,
 *   `docker-compose.prod.yml`, где `INTERNAL_API_URL` задан явно). При
 *   локальном `npm run dev:web` без docker этой DNS-записи нет — и
 *   fallback `http://api:3001/api` приводит к `getaddrinfo ENOTFOUND api`.
 *
 *   Поэтому fallback в `next.config.js` обязан указывать на loopback
 *   (`localhost` / `127.0.0.1`), а не на docker-hostname `api`.
 *
 * Что проверяем:
 *   1. `next.config.js` rewrites не использует hardcoded `api:3001`
 *      в качестве fallback'а.
 *   2. fallback указывает на `localhost`/`127.0.0.1` на :3001.
 *   3. docs/index.md задокументировал контракт «localhost для local
 *      npm, api:3001 для docker», чтобы новые разработчики не
 *      ловили ENOTFOUND повторно.
 *   4. docker-compose-файлы продолжают явно задавать
 *      `INTERNAL_API_URL=http://api:3001/api` — иначе сломаем prod/stage.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('web → api proxy fallback (apps/web/next.config.js)', () => {
  const nextConfig = readSrc('apps/web/next.config.js');

  test('rewrites() читает INTERNAL_API_URL из process.env', () => {
    expect(nextConfig).toMatch(/process\.env\.INTERNAL_API_URL/);
  });

  test('fallback rewrites НЕ использует docker-hostname `api:3001`', () => {
    // Регэксп ловит именно строковый литерал в коде (`'http://api:3001...'`
    // / `"http://api:3001..."`), а не упоминание в комментариях.
    const fallbackLiteral =
      /process\.env\.INTERNAL_API_URL\s*\|\|\s*['"][^'"\n]*['"]/;
    const match = nextConfig.match(fallbackLiteral);
    expect(match, 'fallback-литерал INTERNAL_API_URL || \'…\' должен присутствовать').toBeTruthy();
    const fallback = match![0];
    expect(
      fallback,
      'fallback не должен указывать на docker-hostname `api:3001` — '
        + 'локальный `npm run dev:web` упадёт с ENOTFOUND api',
    ).not.toMatch(/\/\/api:3001/);
  });

  test('fallback rewrites указывает на loopback (`localhost` или `127.0.0.1`) на :3001/api', () => {
    const fallbackLiteral =
      /process\.env\.INTERNAL_API_URL\s*\|\|\s*['"]([^'"\n]+)['"]/;
    const match = nextConfig.match(fallbackLiteral);
    expect(match).toBeTruthy();
    const url = match![1];
    expect(url).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1):3001(\/api)?\/?$/);
  });
});

describe('web → api proxy fallback — docker-compose всё ещё задаёт INTERNAL_API_URL явно', () => {
  test('docker-compose.dev.yml: INTERNAL_API_URL=http://api:3001/api', () => {
    const yml = readSrc('docker-compose.dev.yml');
    expect(yml).toMatch(/INTERNAL_API_URL:\s*http:\/\/api:3001\/api/);
  });

  test('docker-compose.prod.yml: INTERNAL_API_URL=http://api:3001/api', () => {
    const yml = readSrc('docker-compose.prod.yml');
    expect(yml).toMatch(/INTERNAL_API_URL:\s*http:\/\/api:3001\/api/);
  });
});

describe('web → api proxy fallback — docs зафиксировали контракт', () => {
  test('docs/index.md описывает разницу между local npm и docker compose', () => {
    const md = readSrc('docs/index.md');
    expect(md).toMatch(/npm run dev:web/);
    expect(md).toMatch(/docker compose/);
    expect(md).toMatch(/http:\/\/localhost:3001\/api/);
    expect(md).toMatch(/http:\/\/api:3001\/api/);
    expect(md).toMatch(/ENOTFOUND/);
  });
});
