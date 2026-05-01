import { Module } from '@nestjs/common';
import { PurchaseOrderNumberService } from './purchase-order-number.service.js';
import { PurchaseOrdersController } from './purchase-orders.controller.js';
import { PurchaseOrdersOrderController } from './purchase-orders.order-controller.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';

/**
 * Заказы поставщикам (Этап 6А, см.
 * `docs/recon-soft-integration.md §«Этап 6А»`).
 *
 * Закупочный документ без приёмки и без склада: PO создаётся из
 * `WorkshopNeed`, фиксирует supplier-snapshot и item-snapshots,
 * управляется статусами (`DRAFT → SENT → CONFIRMED`, любой →
 * `CANCELLED`). Сознательная граница MVP — нет MaterialReceipt /
 * FabricRoll / Warehouse / Cell связи.
 *
 * Два контроллера:
 *   - `PurchaseOrdersController` — `/api/purchase-orders/*`
 *     (CRUD-light, actions);
 *   - `PurchaseOrdersOrderController` — `/api/orders/:id/purchase-orders`
 *     (список PO по заказу покупателя). Вынесен из
 *     `OrdersController` по той же причине, что и
 *     `WorkshopNeedsOrderController`.
 */
@Module({
  controllers: [PurchaseOrdersController, PurchaseOrdersOrderController],
  providers: [PurchaseOrdersService, PurchaseOrderNumberService],
  exports: [PurchaseOrdersService],
})
export class PurchaseOrdersModule {}
