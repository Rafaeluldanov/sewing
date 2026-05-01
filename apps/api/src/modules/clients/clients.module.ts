import { Module } from '@nestjs/common';
import { ClientsController } from './clients.controller.js';
import { ClientsService } from './clients.service.js';

/**
 * Модуль «Клиенты» — управленческий справочник заказчиков.
 *
 * Контракт — `apps/api/src/modules/clients/clients.controller.ts`
 * (RESTful CRUD без hard-delete). UI — `apps/web/app/admin/clients`.
 * RBAC — `SHOP_MANAGER`/`ADMIN`, проверяется в контроллере декоратором
 * `@Roles(...)`.
 */
@Module({
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
