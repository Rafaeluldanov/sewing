import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthenticatedException } from '../../common/errors.js';
import { AuthService } from './auth.service.js';
import { readSessionCookie } from './auth.controller.js';
import {
  MACHINE_SCOPES_KEY,
  PUBLIC_ROUTE_KEY,
  ROLES_KEY,
} from './auth.decorators.js';
import type { AuthPrincipal, RequestWithAuth } from './auth.types.js';
import { currentActor } from './actor-context.js';
import { readServiceToken } from './service-token.js';
import { ServiceTokenService } from './service-token.service.js';

/**
 * Глобальный AuthGuard.
 *
 * Алгоритм:
 *   1. Если маршрут помечен `@Public()` — пропускаем без проверок.
 *   2. Иначе достаём session-cookie, проверяем подпись и подгружаем
 *      `Employee` из БД (свежие role/active/login/fullName).
 *   3. Прикрепляем `principal` к `req.auth` — оттуда его читают
 *      `@CurrentUser()`, контроллеры и `RolesGuard`.
 *   4. Если есть `@Roles(...)` — проверяем, что роль соответствует.
 *      `ADMIN` всегда проходит.
 *
 * См. ADR-0014 «Auth и сессии (MVP 1.1)».
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ServiceTokenService) private readonly serviceTokens: ServiceTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<RequestWithAuth>();

    // МАШИННАЯ ВЕТКА (сервер-сервер, интеграция с ERP). Входим строго по префиксу
    // токена в `Authorization`. Браузер этот заголовок не шлёт вовсе, поэтому для
    // цехового пути ниже ветка исполнения не меняется ни для одного запроса.
    const bearer = readServiceToken(req.headers.authorization);

    let principal: AuthPrincipal | null;
    if (bearer) {
      principal = await this.serviceTokens.resolvePrincipal(bearer);
    } else {
      const token = readSessionCookie(req.headers.cookie);
      if (!token) throw new UnauthenticatedException();
      principal = await this.auth.resolvePrincipal(token);
    }
    if (!principal) throw new UnauthenticatedException();
    req.auth = principal;

    // Скоупы машины — DENY BY DEFAULT: маршрут без `@MachineScopes(...)` токену закрыт,
    // сколько бы ролей у него ни было. Иначе роль `SHOP_MANAGER` открыла бы интеграции
    // десятки контроллеров (зарплата, казначейство, сотрудники) вместо двух справочников.
    if (principal.kind === 'MACHINE') {
      const scopes = this.reflector.getAllAndOverride<string[] | undefined>(
        MACHINE_SCOPES_KEY,
        [context.getHandler(), context.getClass()],
      );
      const granted = principal.scopes ?? [];
      if (!scopes?.length || !scopes.some((s) => granted.includes(s))) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'FORBIDDEN_SCOPE',
          message: 'Машинному токену этот маршрут не открыт.',
        });
      }
      // Кто из людей ERP нажал — уже в контексте запроса (ActorContextMiddleware): аудит
      // допишет его сам, а FK-поля получат служебного сотрудника из principal (правило §0.1).
      const actor = currentActor();
      this.logger.log(
        `event=auth.machine token=${principal.serviceTokenId} ` +
          `actor=${actor?.id ?? '-'} ${req.method} ${req.originalUrl}`,
      );
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required && required.length > 0) {
      // Фича «несколько ролей»: доступ есть, если ЛЮБАЯ из ролей
      // сотрудника входит в требуемый список. ADMIN проходит везде.
      //
      // `principal.roles` — ЭФФЕКТИВНЫЙ набор: назначенные роли плюс
      // всё, что они наследуют (раскрывает `resolvePrincipal` через
      // `AppRolesService`). Поэтому кастомная роль из `/admin/roles`
      // проходит те же декораторы, что и её донор, а сами декораторы
      // остаются написаны на системных кодах.
      const roles = principal.roles;
      const allowed =
        roles.includes('ADMIN') || required.some((r) => roles.includes(r));
      if (!allowed) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'FORBIDDEN_ROLE',
          message: 'У вашей роли нет доступа к этому действию.',
        });
      }
    }
    return true;
  }
}
