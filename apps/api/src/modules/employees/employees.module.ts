import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';

/**
 * Модуль «Сотрудники» (post-Шаг 18 / Шаг 19, ADR-0021).
 *
 * Контракт — `docs/api.md §10b`. UI — `apps/web/app/admin/employees`.
 * RBAC — только `SHOP_MANAGER`/`ADMIN`, проверяется в контроллере
 * декоратором `@Roles(...)`.
 */
@Module({
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
