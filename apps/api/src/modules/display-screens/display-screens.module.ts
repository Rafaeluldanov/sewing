import { Module } from '@nestjs/common';
import { DisplayScreensController } from './display-screens.controller.js';
import { DisplayScreensService } from './display-screens.service.js';

/**
 * Модуль «Display screens» — конфигурация больших мониторов цеха
 * (`/shopfloor/display`).
 *
 * Контракт — `docs/api.md §11`. UI — `apps/web/app/admin/display-screens`.
 * RBAC — только `SHOP_MANAGER`/`ADMIN`, проверяется в контроллере
 * декоратором `@Roles(...)`.
 *
 * Сервис экспортируется, чтобы `ShopfloorService` (и/или будущие
 * консьюмеры) могли читать конфиг при автоопределении division для
 * DISPLAY-пользователя без дублирования Prisma-запросов.
 */
@Module({
  controllers: [DisplayScreensController],
  providers: [DisplayScreensService],
  exports: [DisplayScreensService],
})
export class DisplayScreensModule {}
