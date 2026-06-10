/**
 * Резолв публичного базового URL API (формат `http(s)://host[:port]/api`),
 * по которому внешние консумеры — в первую очередь Windows print-agent,
 * а также браузер — будут скачивать payload print job-а.
 *
 * ВАЖНО: это НЕ то же самое, что `INTERNAL_API_URL`. Внутренний адрес
 * (loopback `127.0.0.1:3001`) используется только для SSR внутри Next.js,
 * потому что иначе server-side fetch уходит через внешний DNS и падает
 * с `getaddrinfo ENOTFOUND …`. Но для `payloadUrl`, который уезжает
 * `PrintJobDto`'шкой на Windows-агент, loopback смертелен — агент
 * решит, что 127.0.0.1 — это его собственная машина.
 *
 * Порядок резолва (первое непустое значение побеждает):
 *   1. `PUBLIC_API_URL`  — явный публичный адрес API (предпочтительно).
 *   2. `API_PUBLIC_URL`  — устаревший алиас (обратная совместимость).
 *   3. `APP_URL` + `/api` — публичный хост UI + стандартный API-префикс.
 *      Покрывает stage (`https://stage.teeon.ru` → `/api`).
 *   4. Заголовки запроса (`X-Forwarded-*` / `Host`). Если при этом
 *      получился loopback (`127.0.0.1` / `localhost`) — это почти
 *      наверняка SSR-запрос из Next.js, и его нельзя сохранять в
 *      `payloadUrl`. Если у нас нет альтернативы — падаем с понятной
 *      ошибкой, чтобы не записать в БД «битую» ссылку.
 *
 * Вынесено в отдельный модуль, чтобы переиспользовать из
 * `PrintJobsController` (одиночные job-ы) и `WarehousesController`
 * (batch «Печать всех ячеек» через `PrintJobsService.createBatch`).
 */
import type { Request } from 'express';
import { API_PREFIX } from '@sewing/shared/config';
import { PrintPublicApiUrlNotConfiguredException } from '../../common/errors.js';

export function resolvePublicApiBaseUrl(req: Request): string {
  const fromEnv = firstNonEmpty(
    process.env.PUBLIC_API_URL,
    process.env.API_PUBLIC_URL,
  );
  if (fromEnv) return trimTrailingSlash(fromEnv);

  const appUrl = firstNonEmpty(
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  );
  if (appUrl) return `${trimTrailingSlash(appUrl)}${API_PREFIX}`;

  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ??
    req.protocol ??
    'http';
  const host =
    (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0] ??
    (req.headers.host as string | undefined) ??
    '';
  const candidate = host ? `${proto}://${host}${API_PREFIX}` : '';
  if (candidate && !isLoopbackHost(host)) return candidate;

  // Конфигурация окружения не задана — отдаём пользователю понятную
  // 503 (вместо сырой 500 «Внутренняя ошибка»), а детали для devops
  // («укажите PUBLIC_API_URL/APP_URL, loopback нельзя») остаются в коде.
  throw new PrintPublicApiUrlNotConfiguredException();
}

function firstNonEmpty(...vals: Array<string | undefined>): string | null {
  for (const v of vals) {
    if (v && v.trim()) return v.trim();
  }
  return null;
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  const hostname = host.split(':')[0].toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  );
}
