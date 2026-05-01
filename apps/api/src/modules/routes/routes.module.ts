import { Module } from '@nestjs/common';
import { RoutesController } from './routes.controller.js';
import { RoutesService } from './routes.service.js';

/**
 * Production routes (soft-route MVP, см. `docs/domain.md §«Маршруты
 * производства»`). Модуль управляет каталогом шаблонов маршрутов
 * (`RouteTemplate` + `RouteTemplateStep`) и предоставляет публичный
 * API `/api/routes`. Snapshot маршрута на заказе создаётся уже в
 * `OrdersModule` (`OrdersService.start()`), поэтому здесь только CRUD.
 */
@Module({
  controllers: [RoutesController],
  providers: [RoutesService],
  exports: [RoutesService],
})
export class RoutesModule {}
