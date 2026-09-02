import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  UpdateCompanySettingsSchema,
  type OffRouteReadinessDto,
  type TerminateSessionsResponseDto,
  type UpdateCompanySettingsDto,
} from '@sewing/shared/company-settings';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CompanySettingsService } from './company-settings.service.js';

/**
 * Контроллер блока «Настройки компании» (singleton-реквизиты
 * организации).
 *
 *   GET   /api/company-settings                       — текущие реквизиты
 *   GET   /api/company-settings/off-route-readiness   — готовность к BLOCK
 *   PATCH /api/company-settings                       — частичное обновление
 *   POST  /api/company-settings/terminate-sessions    — выгнать всех сейчас
 *
 * RBAC — `SHOP_MANAGER` / `ADMIN`. Ровно как у других управленческих
 * справочников; рабочим ролям эта информация не нужна.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('company-settings')
@MachineScopes('settings:read')
export class CompanySettingsController {
  constructor(private readonly settings: CompanySettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  /**
   * Готовность к включению `BLOCK` — счётчик срабатываний гейта за
   * неделю и список блокеров. Отдельная ручка, а не поле в
   * `GET /company-settings`: это read-модель поверх `AuditLog` и
   * шаблонов маршрутов, и тянуть её на каждом открытии настроек
   * (там же реквизиты, банк, подразделения) незачем.
   */
  @Get('off-route-readiness')
  offRouteReadiness(): Promise<OffRouteReadinessDto> {
    return this.settings.getOffRouteReadiness();
  }

  /**
   * «Завершить все сеансы» — сдвигает отсечку, после которой ранее
   * выданные session-cookie перестают пускать в систему. Отдельная
   * ручка, а не поле в PATCH: это разовое ДЕЙСТВИЕ с моментальным
   * эффектом на весь цех, и его нельзя выполнить случайно, сохраняя
   * форму реквизитов.
   *
   * Выгоняет и того, кто нажал: собственная cookie тоже выпущена до
   * отсечки. Это осознанно — «все» значит все.
   */
  @MachineScopes('settings:write')
  @Post('terminate-sessions')
  @HttpCode(200)
  terminateSessions(
    @CurrentUser() user: AuthPrincipal,
  ): Promise<TerminateSessionsResponseDto> {
    return this.settings.terminateAllSessions(user.employeeId);
  }

  @MachineScopes('settings:write')
  @Patch()
  update(
    @Body(new ZodValidationPipe(UpdateCompanySettingsSchema))
    body: UpdateCompanySettingsDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.settings.update(body, user.employeeId);
  }
}
