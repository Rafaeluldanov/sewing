import { Module } from '@nestjs/common';
import { CompanyDivisionsController } from './company-divisions.controller.js';
import { CompanyDivisionsService } from './company-divisions.service.js';
import { CompanySettingsController } from './company-settings.controller.js';
import { CompanySettingsService } from './company-settings.service.js';

/**
 * Модуль «Настройки компании» — реквизиты организации (singleton)
 * и справочник «Подразделения компании».
 *
 * Контракт:
 *   - `apps/api/src/modules/company-settings/company-settings.controller.ts`
 *     — singleton-настройки (GET / PATCH `/api/company-settings`).
 *   - `apps/api/src/modules/company-settings/company-divisions.controller.ts`
 *     — soft-delete справочник `CompanyDivision`
 *     (GET / POST / GET:id / PATCH:id `/api/company-divisions`).
 *
 * UI — `apps/web/app/admin/company-settings`. RBAC —
 * `SHOP_MANAGER` / `ADMIN`, проверяется на уровне контроллеров
 * декоратором `@Roles(...)`.
 *
 * **Граница модуля.** Сервис подразделений сознательно НЕ связан с
 * `Order` / `Employee` — это другая ось, чем `enum OrderDivision`
 * (см. `prisma/schema.prisma::CompanyDivision` JSDoc и
 * `docs/domain.md §«Настройки компании»`).
 */
@Module({
  controllers: [CompanySettingsController, CompanyDivisionsController],
  providers: [CompanySettingsService, CompanyDivisionsService],
  exports: [CompanySettingsService, CompanyDivisionsService],
})
export class CompanySettingsModule {}
