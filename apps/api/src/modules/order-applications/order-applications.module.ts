import { Module } from '@nestjs/common';
import { OrderApplicationsController } from './order-applications.controller.js';
import { OrderApplicationsService } from './order-applications.service.js';
import { WorkshopNeedsModule } from '../workshop-needs/workshop-needs.module.js';

/**
 * Модуль «Нанесение на заказе покупателя».
 *
 * Источник истины параметров нанесения — `OrderApplication` (см.
 * `prisma/schema.prisma`, `packages/shared/src/order-applications.ts`,
 * `apps/api/src/modules/order-applications/*`).
 *
 * Контракт API:
 *   - `GET /api/orders/:id/applications`
 *   - `PUT /api/orders/:id/applications`  (full-replace)
 *
 * Сервис экспортируется, чтобы консьюмеры (например,
 * `CutReadinessService` / `WorkshopNeedsService`) могли при желании
 * читать нанесения через типизированный API. На MVP оба используют
 * `PrismaService` напрямую — это симметрично остальным модулям и не
 * порождает циркулярных зависимостей.
 *
 * `WorkshopNeedsModule` импортируем ради обратного направления:
 * правка нанесений на заказе в статусе «Расчёт» пересобирает строки
 * `WorkshopNeed` с `sourceType = ORDER_APPLICATION` (см.
 * `OrderApplicationsService.replaceForOrder`). Цикла нет —
 * `WorkshopNeedsModule` ничего не импортирует и читает нанесения через
 * `PrismaService`.
 */
@Module({
  imports: [WorkshopNeedsModule],
  controllers: [OrderApplicationsController],
  providers: [OrderApplicationsService],
  exports: [OrderApplicationsService],
})
export class OrderApplicationsModule {}
