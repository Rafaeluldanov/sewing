import { Controller, Get, Param } from '@nestjs/common';
import type { PurchaseReceiptListItemDto } from '@sewing/shared/purchase-receipts';

import { Roles } from '../auth/auth.decorators.js';
import { PurchaseReceiptsService } from './purchase-receipts.service.js';

/**
 * `/api/purchase-orders/:id/receipts` — список документов приёмки,
 * связанных с конкретным `PurchaseOrder` (Этап 7А).
 *
 * Контроллер вынесен из `PurchaseOrdersController`, чтобы
 * `PurchaseReceiptsModule` сам владел всеми receipt-роутами и не
 * зависел от внутренней структуры purchase-orders.
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER`, новые роли не заводим.
 */
@Controller('purchase-orders')
@Roles('ADMIN', 'SHOP_MANAGER')
export class PurchaseReceiptsPurchaseOrderController {
  constructor(private readonly purchaseReceipts: PurchaseReceiptsService) {}

  @Get(':id/receipts')
  listForPurchaseOrder(
    @Param('id') purchaseOrderId: string,
  ): Promise<PurchaseReceiptListItemDto[]> {
    return this.purchaseReceipts.listForPurchaseOrder(purchaseOrderId);
  }
}
