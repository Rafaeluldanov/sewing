import { Module } from '@nestjs/common';
import { OrderCalculationsController } from './order-calculations.controller.js';
import { OrderCalculationsService } from './order-calculations.service.js';
import { OrdersModule } from '../orders/orders.module.js';
import { WorkshopNeedsModule } from '../workshop-needs/workshop-needs.module.js';

/**
 * Фича «Варианты просчёта заказа» (флаг `FEATURE_ORDER_CALCULATIONS`).
 *
 * `PrismaService` и `AuditService` инжектятся через глобальные модули.
 * `OrdersModule` — ради `OrdersService.resyncColorwayDerived`
 * (пересборка производных после restore снимка) и
 * `updateRouteOverrides` (оверлей расценок/норм варианта). Цикла нет:
 * `OrdersModule` про варианты просчёта ничего не знает (одностороннее
 * ребро, тот же приём, что у `order-colorways`).
 */
@Module({
  imports: [OrdersModule, WorkshopNeedsModule],
  controllers: [OrderCalculationsController],
  providers: [OrderCalculationsService],
  exports: [OrderCalculationsService],
})
export class OrderCalculationsModule {}
