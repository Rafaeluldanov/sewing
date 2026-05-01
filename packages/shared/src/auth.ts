/**
 * Контракты модуля Auth (MVP 1.1, ADR-0014).
 *
 * Сессионная аутентификация заменяет демо-cookie `demo-employee-id` и
 * прямую передачу `employeeId` в теле запросов. Сервер выдаёт HttpOnly
 * cookie `sewing_session` (HMAC-подписанный payload, см.
 * `apps/api/src/modules/auth/session.ts`), web-клиент сохраняет её и
 * прозрачно прокидывает в API при SSR-вызовах.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/auth/login`.
 *
 * Принципал MVP 1.1 — `Employee`. У `Employee.login` уникален в БД,
 * `pinHash` хранит bcrypt-хеш короткого PIN/пароля (в demo-сидинге
 * это `Demo12345!`). В будущих этапах форма входа может расшириться
 * (PIN-only, OTP, пароль + 2FA), но контракт `login + password`
 * сохранится.
 */
export const LoginRequestSchema = z.object({
  login: z
    .string()
    .trim()
    .min(1, 'Логин обязателен')
    .max(64, 'Логин слишком длинный'),
  password: z
    .string()
    .min(1, 'Пароль обязателен')
    .max(256, 'Пароль слишком длинный'),
});
export type LoginRequestDto = z.infer<typeof LoginRequestSchema>;

/**
 * Ответ `POST /api/auth/login` и `GET /api/auth/me` — единый
 * view-model текущего пользователя. Cookie сессии устанавливается
 * заголовком `Set-Cookie`, в теле ответа её нет.
 */
export interface AuthUserDto {
  id: string;
  login: string;
  fullName: string;
  role: string;
}

export interface LoginResponseDto {
  user: AuthUserDto;
}

export type MeResponseDto = LoginResponseDto;

// ---------------------------------------------------------------------------
// Health / Ready (MVP 1.1)
// ---------------------------------------------------------------------------

export interface HealthResponseDto {
  status: 'ok';
  /** ISO timestamp ответа сервера. */
  time: string;
}

export interface ReadyResponseDto {
  status: 'ready' | 'not-ready';
  /** Краткое описание подсистемы, если что-то не готово. */
  reason?: string;
  time: string;
}
