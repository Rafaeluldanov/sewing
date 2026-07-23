import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { WorkshopNeedsModule } from '../workshop-needs/workshop-needs.module.js';
import { OrderAmendmentsController } from './order-amendments.controller.js';
import { OrderAmendmentsService } from './order-amendments.service.js';

/**
 * Фича «Правка заказа в производстве» (order amendments, флаг
 * `FEATURE_ORDER_AMENDMENTS`) — ФАЗА 1: количество по размерам.
 *
 * `PrismaService` и `AuditService` инжектятся глобально (`@Global`).
 * `OrdersModule` импортируем ради `OrdersService.rebuildQtyDerivedSnapshotsInTx`
 * (пересборка снимков материалов/плана под новый тираж),
 * `WorkshopNeedsModule` — ради `calculateForOrder` (best-effort пересчёт
 * потребностей после правки). Циклов нет: оба модуля про amendments не
 * знают (одностороннее ребро, как у `order-colorways`).
 */
@Module({
  imports: [OrdersModule, WorkshopNeedsModule],
  controllers: [OrderAmendmentsController],
  providers: [OrderAmendmentsService],
  exports: [OrderAmendmentsService],
})
export class OrderAmendmentsModule {}
