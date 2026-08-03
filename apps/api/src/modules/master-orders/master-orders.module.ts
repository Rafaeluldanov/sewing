import { Module } from '@nestjs/common';
import { MasterOrdersController } from './master-orders.controller.js';
import { MasterOrdersService } from './master-orders.service.js';

/**
 * Вкладка «Заказы» кабинета мастера (read-only список заказов с
 * маршрутом и фронтом производства).
 *
 * См. `apps/api/src/modules/master-orders/master-orders.controller.ts`,
 * `packages/shared/src/master-orders.ts`, `apps/web/app/master`.
 *
 * `PrismaService` инжектится через глобальный `PrismaModule` — отдельные
 * `imports` не требуются.
 */
@Module({
  controllers: [MasterOrdersController],
  providers: [MasterOrdersService],
  exports: [MasterOrdersService],
})
export class MasterOrdersModule {}
