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
export const MACHINE_SCOPES_KEY = 'auth:machine-scopes';

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
 * Декоратор `@MachineScopes(...)` открывает маршрут МАШИННОМУ токену.
 *
 * Гвард работает DENY BY DEFAULT: без этого декоратора машинный токен не пройдёт
 * никуда, какие бы роли ему ни выдали. Причина простая — роль `SHOP_MANAGER` открывает
 * десятки контроллеров (зарплата, казначейство, сотрудники), а интеграции нужны два
 * справочника. На людей декоратор не влияет вообще: их пускают роли.
 */
export const MachineScopes = (
  ...scopes: string[]
): MethodDecorator & ClassDecorator => SetMetadata(MACHINE_SCOPES_KEY, scopes);

/**
 * `@MachineClosed()` — явно закрыть хендлер машинному токену, когда класс открыт на чтение.
 *
 * Классовый `@MachineScopes('x:read')` распространяется и на POST/PATCH класса; там, где
 * запись машине не положена (зарплата, снапшоты себестоимости, очередь печати), нужен
 * хендлерный декоратор с ПУСТЫМ списком: гвард трактует пустой список как «никому».
 * Явное имя, а не `@MachineScopes()` без аргументов: пустые скобки читаются как забытые.
 */
export const MachineClosed = (): MethodDecorator & ClassDecorator =>
  SetMetadata(MACHINE_SCOPES_KEY, []);

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
