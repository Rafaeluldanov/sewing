/**
 * Серверная обёртка над `GET /api/me/employee-qr`.
 *
 * Источник истины контракта — `apps/api/src/modules/me/me.controller.ts`
 * и `packages/shared/src/employee-qr.ts`. Используется из
 * server-action'а (`apps/web/app/employee-qr/actions.ts`), который в
 * свою очередь дёргается клиентской кнопкой «Мой QR-код»
 * (`apps/web/components/employees/employee-qr-button.tsx`).
 *
 * Клиент напрямую fetch'ить не может: session-cookie HttpOnly, а
 * API может жить на другом хосте (`api.prod.*`) — см. `lib/api.ts`.
 * Поэтому все обращения идут через RSC/actions.
 */

import type { EmployeeQrResponseDto } from '@sewing/shared/employee-qr';
import { apiFetch } from './api';

/**
 * Запрашивает у API подписанный QR-код текущего сотрудника. Не
 * кэшируется (`cache: 'no-store'` — поведение по умолчанию в
 * `apiFetch`), чтобы каждый клик приносил свежий `expiresAt`.
 *
 * Ошибки (бросаются наверх):
 *   - 401 `UNAUTHENTICATED` — сессия истекла.
 *   - 404 `EMPLOYEE_PROFILE_NOT_FOUND` — у юзера нет карточки.
 *   - 403 `EMPLOYEE_INACTIVE` — карточка деактивирована.
 */
export function getMyEmployeeQrCode(): Promise<EmployeeQrResponseDto> {
  return apiFetch<EmployeeQrResponseDto>('/me/employee-qr');
}
