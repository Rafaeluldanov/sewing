import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import {
  UpdateIntegrationSettingsSchema,
  type UpdateIntegrationSettingsDto,
} from '@sewing/shared/integration';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { IntegrationsService } from './integrations.service.js';

/**
 * Контроллер модуля «Интеграции» — настройки подключения к внешнему ERP
 * upgifts и проверка соединения. Полный дизайн —
 * `docs/upgifts-integration.md`.
 *
 *   GET   /api/integrations/settings                — текущие настройки
 *                                                      (пароль не отдаётся)
 *   PATCH /api/integrations/settings                — частичное обновление
 *   POST  /api/integrations/upgifts/test-connection — логин + /auth/me
 *
 * RBAC — `SHOP_MANAGER` / `ADMIN` (как у company-settings).
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('settings')
  get() {
    return this.integrations.get();
  }

  @Patch('settings')
  update(
    @Body(new ZodValidationPipe(UpdateIntegrationSettingsSchema))
    body: UpdateIntegrationSettingsDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.integrations.update(body, user.employeeId);
  }

  @Post('upgifts/test-connection')
  testConnection() {
    return this.integrations.testConnection();
  }

  @Post('assistant/test-key')
  testAssistantKey() {
    return this.integrations.testAssistantKey();
  }
}
