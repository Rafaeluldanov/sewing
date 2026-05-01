import { Controller, Get, Param } from '@nestjs/common';
import type { PurchaseOrderListItemDto } from '@sewing/shared/purchase-orders';

import { Roles } from '../auth/auth.decorators.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';

/**
 * `/api/orders/:id/purchase-orders` — список закупочных документов,
 * связанных с конкретным заказом покупателя (Этап 6А).
 *
 * Контроллер вынесен из `OrdersController` сознательно (по той же
 * причине, что `WorkshopNeedsOrderController`):
 *   - `OrdersController` имеет `@Roles('SHOP_MANAGER')` на классе
 *     и отдельную семантику CRUD-заказа;
 *   - все purchase-orders роуты живут в `PurchaseOrdersModule`,
 *     это упрощает читаемость и тестирование.
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER`, новые роли не заводим.
 */
@Controller('orders')
@Roles('ADMIN', 'SHOP_MANAGER')
export class PurchaseOrdersOrderController {
  constructor(private readonly purchaseOrders: PurchaseOrdersService) {}

  @Get(':id/purchase-orders')
  listForCustomerOrder(
    @Param('id') orderId: string,
  ): Promise<PurchaseOrderListItemDto[]> {
    return this.purchaseOrders.listForCustomerOrder(orderId);
  }
}
