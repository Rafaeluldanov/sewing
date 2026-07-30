import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthenticatedException } from '../../common/errors.js';
import { AuthService } from './auth.service.js';
import { readSessionCookie } from './auth.controller.js';
import { PUBLIC_ROUTE_KEY, ROLES_KEY } from './auth.decorators.js';
import type { RequestWithAuth } from './auth.types.js';

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
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = readSessionCookie(req.headers.cookie);
    if (!token) throw new UnauthenticatedException();

    const principal = await this.auth.resolvePrincipal(token);
    if (!principal) throw new UnauthenticatedException();
    req.auth = principal;

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
