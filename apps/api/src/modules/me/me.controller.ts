import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { EmployeeQrResponseDto } from '@sewing/shared/employee-qr';
import type { MeDailyDto, MeHistoryDto } from '@sewing/shared/me-daily';
import { MeHistoryQuerySchema } from '@sewing/shared/me-daily';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { UnauthenticatedException } from '../../common/errors.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { MeService } from './me.service.js';

/**
 * Контроллер «мой профиль» (`/api/me/*`).
 *
 * Все маршруты защищены глобальным `AuthGuard` (нет `@Public()`).
 * `@Roles(...)` сознательно не навешан: личный кабинет доступен любому
 * авторизованному сотруднику — каждый видит ТОЛЬКО свои данные,
 * скоупинг происходит внутри сервиса по `principal.employeeId`.
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

  /**
   * Дневной snapshot для виджета «Мой день» в кабинете сотрудника.
   * См. JSDoc `MeService.getDaily` для логики ветвления по
   * `compensationType` и политики PENDING.
   */
  @Get('daily')
  async getDaily(
    @CurrentUser() principal: AuthPrincipal | undefined,
  ): Promise<MeDailyDto> {
    if (!principal) throw new UnauthenticatedException();
    return this.me.getDaily(principal);
  }

  /**
   * История по дням для модалки «История 30 дней». `days` — горизонт в
   * сутках (1..90, по умолчанию 30), валидируется `MeHistoryQuerySchema`.
   */
  @Get('history')
  async getHistory(
    @CurrentUser() principal: AuthPrincipal | undefined,
    @Query(new ZodValidationPipe(MeHistoryQuerySchema))
    query: { days: number },
  ): Promise<MeHistoryDto> {
    if (!principal) throw new UnauthenticatedException();
    return this.me.getHistory(principal, query);
  }
}
