/**
 * Сессионный токен MVP 1.1.
 *
 * Формат — компактный самопроверяемый payload (`base64url(json).base64url(sig)`),
 * подписанный HMAC-SHA256 по `JWT_SECRET`. Не вводим внешнюю JWT-зависимость:
 * нам нужен ровно один тип токена (session cookie), без RSA-key rotation,
 * без кастомных claim-ов и без интеграции с третьими сервисами.
 *
 * Поля payload:
 *   - `sub` — `Employee.id` (логичный subject);
 *   - `role` — `Employee.role` (для быстрых RBAC-проверок без обращения в БД);
 *   - `iat` — Unix-секунды выпуска;
 *   - `exp` — Unix-секунды истечения;
 *   - `v` — версия схемы payload (на случай несовместимых правок).
 *
 * Cookie — HttpOnly. Подделка невозможна без знания `JWT_SECRET`.
 * См. ADR-0014 «Auth и сессии» и `docs/architecture.md §8`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Role } from '@prisma/client';

export interface SessionPayload {
  sub: string;
  role: Role;
  iat: number;
  exp: number;
  v: 1;
}

export interface SessionOptions {
  /** Подпись токена. Должна совпадать с `JWT_SECRET` API-инстанса. */
  secret: string;
  /** Время жизни сессии в секундах. По умолчанию 12 часов. */
  ttlSeconds: number;
}

const PAYLOAD_VERSION = 1 as const;

export function signSession(
  payload: Omit<SessionPayload, 'iat' | 'exp' | 'v'>,
  opts: SessionOptions,
  now: Date = new Date(),
): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + opts.ttlSeconds;
  const full: SessionPayload = { ...payload, iat, exp, v: PAYLOAD_VERSION };
  const body = base64UrlEncode(Buffer.from(JSON.stringify(full)));
  const sig = base64UrlEncode(hmac(body, opts.secret));
  return {
    token: `${body}.${sig}`,
    expiresAt: new Date(exp * 1000),
  };
}

/**
 * Проверка подписи и срока действия. Возвращает `null`, если токен:
 *   - имеет неверный формат;
 *   - подписан другим секретом;
 *   - истёк;
 *   - имеет неподдерживаемую версию payload.
 *
 * Сознательно НЕ кидает исключения наружу: вызывающая сторона должна
 * сама решать, как реагировать (401 vs anonymous fallback).
 */
export function verifySession(
  token: string,
  opts: Pick<SessionOptions, 'secret'>,
  now: Date = new Date(),
): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expectedSig = base64UrlEncode(hmac(body, opts.secret));
  if (!safeEqual(sig, expectedSig)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!isSessionPayload(payload)) return null;
  if (payload.v !== PAYLOAD_VERSION) return null;
  if (payload.exp <= Math.floor(now.getTime() / 1000)) return null;
  return payload;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sub === 'string' &&
    typeof v.role === 'string' &&
    typeof v.iat === 'number' &&
    typeof v.exp === 'number' &&
    typeof v.v === 'number'
  );
}

function hmac(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(s: string): Buffer {
  const padded = s + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
