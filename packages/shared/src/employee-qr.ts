/**
 * Контракты модуля «Мой QR-код сотрудника» (post-master-calls, MVP).
 *
 * Источник истины — `apps/api/src/modules/me/me.controller.ts`,
 * `apps/api/src/modules/auth/employee-qr-token.ts`. UI — client
 * component `apps/web/components/employees/employee-qr-button.tsx`,
 * server-side обёртка `apps/web/lib/employee-qr-api.ts`.
 *
 * Задача — дать сотруднику на рабочем терминале кнопку «Мой QR-код».
 * Открывается модалка с QR, который мастер сканирует на `/master`
 * (см. `EMPLOYEE_QR_PREFIX` в `./master-calls.ts`) или считывает
 * рабочий терминал. В QR зашит подписанный токен, а не «голый»
 * `Employee.id`: токен истекает через 12 часов, его нельзя
 * отредактировать без секрета `JWT_SECRET`, и он не содержит никаких
 * персональных данных (пароль/cookie/телефон/паспорт) — только
 * `employeeId`, `userId` (в SEWING всегда равен `employeeId`, см.
 * `docs/domain.md §«Auth и сессии»`) и `role`.
 *
 * QR payload имеет префикс `SEWING_EMPLOYEE:` вместо исторического
 * `EMPLOYEE:` — это сознательное разделение: старый префикс ходит в
 * unsigned PNG-этикетках (`/api/employees/:id/print`) и в текущем
 * `/master` scan-flow. Новый префикс несёт подпись и срок жизни и
 * безопаснее для будущих scan-driven терминалов.
 */

import { z } from 'zod';

/**
 * Префикс QR-payload'а «мой QR-код сотрудника». Подписанный токен
 * идёт после двоеточия. Формат payload'а: `SEWING_EMPLOYEE:<token>`.
 */
export const EMPLOYEE_QR_PAYLOAD_PREFIX = 'SEWING_EMPLOYEE:' as const;

/**
 * Тип подписанного payload'а внутри токена (см.
 * `apps/api/src/modules/auth/employee-qr-token.ts`). Отдельный
 * `type` выделяет этот токен от session-cookie: даже если кто-то
 * случайно попытается проверить session-payload как QR (или
 * наоборот), mismatch `type` срежет его при `verify`.
 */
export const EMPLOYEE_QR_TOKEN_TYPE = 'EMPLOYEE_QR' as const;

/**
 * Schema подписанного payload'а. Валидируется при verify на
 * backend и может переиспользоваться в тестах/утилитах.
 *
 * - `type`          — всегда `EMPLOYEE_QR` (защита от подмены токена).
 * - `employeeId`    — `Employee.id` (в SEWING это же и `userId`).
 * - `userId`        — продублировано ради совместимости со стандартной
 *                     в отрасли схемой «user + employee»: в SEWING
 *                     сущности пока совпадают, но это не обязывает
 *                     клиента это знать.
 * - `role`          — `Employee.role` (для быстрых RBAC-проверок
 *                     терминалом без обращения в БД).
 * - `iat` / `exp`   — Unix-секунды, как в session-payload.
 * - `v`             — версия схемы payload'а.
 */
export const EmployeeQrTokenPayloadSchema = z.object({
  type: z.literal(EMPLOYEE_QR_TOKEN_TYPE),
  employeeId: z.string().min(1),
  userId: z.string().min(1),
  role: z.string().min(1),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  v: z.literal(1),
});

export type EmployeeQrTokenPayload = z.infer<
  typeof EmployeeQrTokenPayloadSchema
>;

/**
 * Response-DTO `GET /api/me/employee-qr`.
 *
 * - `employee` — минимальная безопасная карточка: id/ФИО/роль.
 *               Никаких pinHash, login, phone, passport data и др.
 * - `qrPayload` — готовая строка для QR-рендера на фронте
 *                 (включая префикс `SEWING_EMPLOYEE:`).
 * - `expiresAt` — ISO-метка истечения токена. Используется UI, чтобы
 *                 мягко рефрешить окно или показать таймер.
 */
export interface EmployeeQrResponseDto {
  employee: {
    id: string;
    name: string;
    role: string;
  };
  qrPayload: string;
  expiresAt: string;
}

/**
 * Парсит payload QR-кода сотрудника с префиксом `SEWING_EMPLOYEE:`.
 * Возвращает подписанный токен или `null`, если строка не
 * соответствует ожидаемому формату.
 *
 * Сам токен НЕ валидируется здесь — эта проверка делается только
 * на backend'е через `verifyEmployeeQrToken` (подпись + `exp` + `v`).
 * Utility доступна UI, чтобы, например, pre-validate payload перед
 * отправкой на сервер.
 */
export function parseSewingEmployeeQrPayload(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length <= EMPLOYEE_QR_PAYLOAD_PREFIX.length) return null;
  if (!trimmed.startsWith(EMPLOYEE_QR_PAYLOAD_PREFIX)) return null;
  const token = trimmed.slice(EMPLOYEE_QR_PAYLOAD_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}
