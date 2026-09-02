import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  UpdateIntegrationSettingsSchema,
  type UpdateIntegrationSettingsDto,
} from '@sewing/shared/integration';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ERP_WINDOW_SCOPES } from '../auth/service-token.js';
import { ServiceTokenService } from '../auth/service-token.service.js';
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
 *   GET   /api/integrations/service-tokens          — машинные токены (без секретов)
 *   POST  /api/integrations/service-tokens          — выпустить (плейнтекст ОДИН раз)
 *   POST  /api/integrations/service-tokens/:id/revoke — отозвать
 *
 * RBAC — `SHOP_MANAGER` / `ADMIN` (как у company-settings).
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly serviceTokens: ServiceTokenService,
  ) {}

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

  /**
   * Машинные токены: доступ ERP к справочникам швейки сервер-сервер.
   *
   * Список отдаётся БЕЗ секретов — только префикс для опознания. Сам токен виден
   * ровно один раз, в ответе на выпуск: в БД лежит только sha256, восстановить нечем.
   */
  @Get('service-tokens')
  listServiceTokens() {
    return this.serviceTokens.list();
  }

  @Post('service-tokens')
  issueServiceToken(
    @Body() body: { name?: string; scopes?: string[] },
    @CurrentUser() user: AuthPrincipal,
  ) {
    // Скоупы по умолчанию — набор «окна ERP» (`ERP_WINDOW_SCOPES`): всё, чем ERP рисует у себя
    // экраны цеха, и ничего сверх. Явно переданный список его перекрывает — токен под узкую
    // задачу выпускается с ним, а не правкой умолчания.
    const scopes = body.scopes?.length ? body.scopes : [...ERP_WINDOW_SCOPES];
    return this.serviceTokens.issue({
      name: body.name?.trim() || 'ERP upgifts',
      scopes,
      createdById: user.employeeId,
    });
  }

  @Post('service-tokens/:id/revoke')
  revokeServiceToken(@Param('id') id: string, @CurrentUser() user: AuthPrincipal) {
    return this.serviceTokens.revoke(id, user.employeeId);
  }

  @Post('assistant/test-key')
  testAssistantKey() {
    return this.integrations.testAssistantKey();
  }
}
