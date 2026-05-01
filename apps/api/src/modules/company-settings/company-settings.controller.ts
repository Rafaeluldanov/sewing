import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  UpdateCompanySettingsSchema,
  type UpdateCompanySettingsDto,
} from '@sewing/shared/company-settings';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CompanySettingsService } from './company-settings.service.js';

/**
 * Контроллер блока «Настройки компании» (singleton-реквизиты
 * организации).
 *
 *   GET   /api/company-settings   — текущие реквизиты (idemp-create)
 *   PATCH /api/company-settings   — частичное обновление (любое
 *                                    подмножество полей)
 *
 * RBAC — `SHOP_MANAGER` / `ADMIN`. Ровно как у других управленческих
 * справочников; рабочим ролям эта информация не нужна.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('company-settings')
export class CompanySettingsController {
  constructor(private readonly settings: CompanySettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Patch()
  update(
    @Body(new ZodValidationPipe(UpdateCompanySettingsSchema))
    body: UpdateCompanySettingsDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.settings.update(body, user.employeeId);
  }
}
