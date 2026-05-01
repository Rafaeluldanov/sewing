import { Controller, Get, Param } from '@nestjs/common';
import type { PurchaseReceiptListItemDto } from '@sewing/shared/purchase-receipts';

import { Roles } from '../auth/auth.decorators.js';
import { PurchaseReceiptsService } from './purchase-receipts.service.js';

/**
 * `/api/orders/:id/purchase-receipts` — список документов приёмки,
 * связанных с заказом покупателя (Этап 7А).
 *
 * Контроллер вынесен из `OrdersController` сознательно (по той же
 * причине, что `PurchaseOrdersOrderController`):
 *   - `OrdersController` имеет `@Roles('SHOP_MANAGER')` на классе
 *     и отдельную семантику CRUD-заказа;
 *   - все receipt-роуты живут в `PurchaseReceiptsModule`.
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER`, новые роли не заводим.
 */
@Controller('orders')
@Roles('ADMIN', 'SHOP_MANAGER')
export class PurchaseReceiptsOrderController {
  constructor(private readonly purchaseReceipts: PurchaseReceiptsService) {}

  @Get(':id/purchase-receipts')
  listForCustomerOrder(
    @Param('id') orderId: string,
  ): Promise<PurchaseReceiptListItemDto[]> {
    return this.purchaseReceipts.listForCustomerOrder(orderId);
  }
}
