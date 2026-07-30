import {
  SetMetadata,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import type { SystemRoleCode } from '@sewing/shared/app-roles';
import type { AuthPrincipal, RequestWithAuth } from './auth.types.js';

/**
 * Метки для глобальных гвардов (см. `./auth.guard.ts`, `./roles.guard.ts`).
 */
export const PUBLIC_ROUTE_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';

/**
 * Декоратор `@Public()` помечает маршрут как доступный без сессии
 * (login, health, ready). Глобальный `AuthGuard` пропустит его без
 * валидации cookie.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_ROUTE_KEY, true);

/**
 * Декоратор `@Roles(...)` ограничивает маршрут заданным набором ролей.
 * Без декоратора маршрут доступен любому авторизованному пользователю.
 * `ADMIN` всегда имеет доступ — это запекается в `AuthGuard`.
 *
 * Здесь перечисляются СИСТЕМНЫЕ коды (`SystemRoleCode`) — те, что зашиты
 * в приложении. Кастомные роли из `/admin/roles` в декораторах не
 * упоминаются никогда: они получают доступ наследованием, `AuthGuard`
 * раскрывает их набор до сравнения (см. `AppRolesService.expand`).
 */
export const Roles = (
  ...roles: SystemRoleCode[]
): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/**
 * Параметр-декоратор `@CurrentUser()` достаёт `AuthPrincipal`,
 * прикреплённый `AuthGuard` к запросу. На public-маршрутах вернёт
 * `undefined` — поэтому в обработчике это нужно учитывать.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal | undefined => {
    const req = ctx.switchToHttp().getRequest<RequestWithAuth>();
    return req.auth;
  },
);
