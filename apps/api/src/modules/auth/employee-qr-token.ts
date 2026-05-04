/**
 * Подписанный токен «Мой QR-код сотрудника» (MVP).
 *
 * Формат — compact self-contained: `base64url(json).base64url(sig)`,
 * подписан HMAC-SHA256 по `JWT_SECRET` (тот же секрет, что и у
 * session-cookie — см. `./session.ts` и ADR-0014). Не тащим внешнюю
 * JWT-библиотеку: алгоритм один, структура payload фиксирована,
 * ключей не ротация.
 *
 * Зачем отдельный токен (а не reuse session-payload'а):
 *   1. Payload содержит `type: 'EMPLOYEE_QR'` — защита от того, что
 *      кто-то попробует «подсунуть» session-token как QR (и
 *      наоборот): `verifyEmployeeQrToken` срежет mismatch `type`.
 *   2. Payload свободен от session-специфических claim'ов
 *      (`sub`, `role` напрямую не хватит — нужен явный
 *      `employeeId`/`userId`/`type`).
 *   3. Срок жизни и TTL можно тюнить независимо от session-cookie
 *      (на MVP — те же 12 часов; в будущем можно вшить shift-end).
 *
 * Публичный контракт payload'а дублирован в
 * `packages/shared/src/employee-qr.ts` (`EmployeeQrTokenPayload`,
 * `EMPLOYEE_QR_TOKEN_TYPE`) — оттуда его импортируют UI и тесты, а
 * сам backend обходит shared без нужды: crypto-утилиты работают
 * только в Node runtime.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Role } from '@prisma/client';
import {
  EMPLOYEE_QR_TOKEN_TYPE,
  type EmployeeQrTokenPayload,
} from '@sewing/shared/employee-qr';

export const EMPLOYEE_QR_DEFAULT_TTL_SECONDS = 12 * 60 * 60;

const PAYLOAD_VERSION = 1 as const;

export interface SignEmployeeQrInput {
  employeeId: string;
  userId: string;
  role: Role;
}

export interface EmployeeQrSignOptions {
  /** Подпись токена. Должна совпадать с `JWT_SECRET` API-инстанса. */
  secret: string;
  /** Время жизни токена в секундах. По умолчанию 12 часов. */
  ttlSeconds: number;
}

/**
 * Выпускает подписанный токен QR-кода сотрудника. Возвращает сам
 * токен (без префикса) и `expiresAt` — таймстамп истечения, чтобы
 * UI мог показывать таймер/рефрешить окно.
 */
export function signEmployeeQrToken(
  input: SignEmployeeQrInput,
  opts: EmployeeQrSignOptions,
  now: Date = new Date(),
): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + opts.ttlSeconds;
  const full: EmployeeQrTokenPayload = {
    type: EMPLOYEE_QR_TOKEN_TYPE,
    employeeId: input.employeeId,
    userId: input.userId,
    role: input.role,
    iat,
    exp,
    v: PAYLOAD_VERSION,
  };
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
 *   - содержит `type != 'EMPLOYEE_QR'` (например, session-cookie —
 *     защита от перекрёстного подсовывания токенов);
 *   - имеет неподдерживаемую версию payload'а.
 *
 * Сознательно НЕ кидает исключения — вызывающая сторона решает,
 * как реагировать (обычно — считать QR невалидным).
 */
export function verifyEmployeeQrToken(
  token: string,
  opts: Pick<EmployeeQrSignOptions, 'secret'>,
  now: Date = new Date(),
): EmployeeQrTokenPayload | null {
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
  if (!isEmployeeQrPayload(payload)) return null;
  if (payload.type !== EMPLOYEE_QR_TOKEN_TYPE) return null;
  if (payload.v !== PAYLOAD_VERSION) return null;
  if (payload.exp <= Math.floor(now.getTime() / 1000)) return null;
  return payload;
}

function isEmployeeQrPayload(value: unknown): value is EmployeeQrTokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    typeof v.employeeId === 'string' &&
    typeof v.userId === 'string' &&
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
