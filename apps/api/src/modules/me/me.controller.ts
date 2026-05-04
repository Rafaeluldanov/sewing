import { Controller, Get, Inject } from '@nestjs/common';
import type { EmployeeQrResponseDto } from '@sewing/shared/employee-qr';
import { UnauthenticatedException } from '../../common/errors.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { MeService } from './me.service.js';

/**
 * Контроллер «мой профиль» (`/api/me/*`, MVP).
 *
 * Контракты — `docs/api.md §1a Me`. На MVP доступен один маршрут —
 * `GET /api/me/employee-qr`. Класс защищён глобальным `AuthGuard`
 * (нет `@Public()`); декоратор `@Roles(...)` не навешан
 * сознательно: «мой QR» показывает любой авторизованный сотрудник
 * себе же — включая роли, на которые не распространяется остальной
 * employee-UI (например, ADMIN смотрит QR тестовой учётки).
 *
 * RBAC-отсечки «скрыть кнопку у DISPLAY» живут на UI
 * (`apps/web/lib/rbac.ts`), а не здесь: endpoint обязан не падать
 * 403'ым в корректном сценарии «ADMIN/SHOP_MANAGER смотрит свой QR
 * для тестирования сканера», так что гранулярную проверку на роль
 * сознательно не делаем.
 */
@Controller('me')
export class MeController {
  constructor(@Inject(MeService) private readonly me: MeService) {}

  @Get('employee-qr')
  async getEmployeeQr(
    @CurrentUser() principal: AuthPrincipal | undefined,
  ): Promise<EmployeeQrResponseDto> {
    if (!principal) throw new UnauthenticatedException();
    return this.me.buildEmployeeQr(principal);
  }
}
