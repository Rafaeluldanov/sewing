import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ControlPlaneService } from '../../prisma/control-plane.service.js';
import type { RequestWithAuth } from '../auth/auth.types.js';

/**
 * Гард панели супер-админа control-plane.
 *
 * ВАЖНО (граница безопасности): требует роль `SUPERADMIN` ЯВНО и НЕ пускает
 * обычного `ADMIN`. Глобальный `AuthGuard` + `@Roles(...)` наоборот всегда
 * пропускает ADMIN — поэтому для cross-tenant control-plane используем
 * отдельный гард, а не `@Roles('SUPERADMIN')`. Глобальный AuthGuard к этому
 * моменту уже аутентифицировал запрос и положил `req.auth`.
 *
 * Плюс: если control-plane выключен (`CONTROL_PLANE_DATABASE_URL` не задан) —
 * панель не имеет смысла, отвечаем 404.
 */
@Injectable()
export class SuperadminGuard implements CanActivate {
  constructor(private readonly controlPlane: ControlPlaneService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.controlPlane.isEnabled()) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'CONTROL_PLANE_DISABLED',
        message: 'Control-plane выключен — панель тенантов недоступна.',
      });
    }
    const req = context.switchToHttp().getRequest<RequestWithAuth>();
    const roles = req.auth?.roles ?? [];
    if (!roles.includes('SUPERADMIN')) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'FORBIDDEN_ROLE',
        message: 'Доступ только для супер-админа control-plane.',
      });
    }
    return true;
  }
}
