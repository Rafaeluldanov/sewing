/**
 * Unit-тесты подписанного токена «Мой QR-код сотрудника»
 * (`apps/api/src/modules/auth/employee-qr-token.ts`).
 *
 * Сознательно работаем на уровне чистых функций — без Nest DI и без
 * БД — потому что безопасность токена (подпись, tamper-resistance,
 * срок жизни, разделение с session-payload'ом) проверяется именно
 * здесь; integration-тесты дополнительно валидируют DI-сборку.
 */
import { describe, expect, test } from 'vitest';
import {
  EMPLOYEE_QR_DEFAULT_TTL_SECONDS,
  signEmployeeQrToken,
  verifyEmployeeQrToken,
} from '@sewing/api/modules/auth/employee-qr-token';
import { EMPLOYEE_QR_TOKEN_TYPE } from '@sewing/shared/employee-qr';

const SECRET = 'test-secret-please-ignore';
const OTHER_SECRET = 'another-secret';

function input() {
  return {
    employeeId: 'emp_123',
    userId: 'emp_123',
    role: 'SEAMSTRESS' as const,
  };
}

describe('employee-qr-token', () => {
  test('sign → verify round-trip возвращает тот же payload', () => {
    const now = new Date('2026-05-04T12:00:00.000Z');
    const { token, expiresAt } = signEmployeeQrToken(
      input(),
      { secret: SECRET, ttlSeconds: EMPLOYEE_QR_DEFAULT_TTL_SECONDS },
      now,
    );
    expect(expiresAt.getTime()).toBe(
      now.getTime() + EMPLOYEE_QR_DEFAULT_TTL_SECONDS * 1000,
    );
    const parsed = verifyEmployeeQrToken(token, { secret: SECRET }, now);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe(EMPLOYEE_QR_TOKEN_TYPE);
    expect(parsed!.employeeId).toBe('emp_123');
    expect(parsed!.userId).toBe('emp_123');
    expect(parsed!.role).toBe('SEAMSTRESS');
    expect(parsed!.v).toBe(1);
  });

  test('подмена подписи срезается при verify', () => {
    const now = new Date('2026-05-04T12:00:00.000Z');
    const { token } = signEmployeeQrToken(
      input(),
      { secret: SECRET, ttlSeconds: EMPLOYEE_QR_DEFAULT_TTL_SECONDS },
      now,
    );
    // Мутируем последний символ подписи.
    const tampered =
      token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
    expect(verifyEmployeeQrToken(tampered, { secret: SECRET }, now)).toBeNull();
  });

  test('токен, подписанный другим секретом, отвергается', () => {
    const now = new Date('2026-05-04T12:00:00.000Z');
    const { token } = signEmployeeQrToken(
      input(),
      { secret: SECRET, ttlSeconds: EMPLOYEE_QR_DEFAULT_TTL_SECONDS },
      now,
    );
    expect(
      verifyEmployeeQrToken(token, { secret: OTHER_SECRET }, now),
    ).toBeNull();
  });

  test('истёкший токен отвергается', () => {
    const now = new Date('2026-05-04T12:00:00.000Z');
    const { token } = signEmployeeQrToken(
      input(),
      { secret: SECRET, ttlSeconds: 1 },
      now,
    );
    const later = new Date(now.getTime() + 2 * 1000);
    expect(verifyEmployeeQrToken(token, { secret: SECRET }, later)).toBeNull();
  });

  test('type=EMPLOYEE_QR — защита от перекрёстного подсовывания', () => {
    // Симулируем «session-like» payload (type=SESSION). Он должен
    // быть отвергнут, даже если подпись валидна.
    const now = new Date('2026-05-04T12:00:00.000Z');
    const otherPayload = JSON.stringify({
      type: 'SESSION',
      employeeId: 'emp_123',
      userId: 'emp_123',
      role: 'SEAMSTRESS',
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 60,
      v: 1,
    });
    // Собираем самопальный токен с тем же секретом и форматом, но с
    // чужим `type` — это единственный способ проверить, что verify
    // не смотрит на payload поверхностно.
    const body = base64UrlEncode(Buffer.from(otherPayload));
    const sig = base64UrlEncode(
      require('node:crypto').createHmac('sha256', SECRET).update(body).digest(),
    );
    const forged = `${body}.${sig}`;
    expect(verifyEmployeeQrToken(forged, { secret: SECRET }, now)).toBeNull();
  });

  test('payload не содержит login/pinHash/cookie/passport', () => {
    const { token } = signEmployeeQrToken(
      input(),
      { secret: SECRET, ttlSeconds: 60 },
    );
    const body = token.slice(0, token.indexOf('.'));
    const padded = body + '==='.slice((body.length + 3) % 4);
    const payloadJson = Buffer.from(
      padded.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const keys = Object.keys(JSON.parse(payloadJson));
    for (const forbidden of [
      'login',
      'pinHash',
      'passwordHash',
      'password',
      'pin',
      'cookie',
      'session',
      'sessionId',
      'phone',
      'passport',
      'salary',
      'fullName',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
