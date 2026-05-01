import { Module } from '@nestjs/common';
import { PurchaseReceiptNumberService } from './purchase-receipt-number.service.js';
import { PurchaseReceiptsController } from './purchase-receipts.controller.js';
import { PurchaseReceiptsOrderController } from './purchase-receipts.order-controller.js';
import { PurchaseReceiptsPurchaseOrderController } from './purchase-receipts.purchase-order-controller.js';
import { PurchaseReceiptsService } from './purchase-receipts.service.js';

/**
 * Документы приёмки (Этап 7А, см.
 * `docs/recon-soft-integration.md §«Этап 7А»`).
 *
 * Фактическая приёмка по `PurchaseOrder` + размещение в физической
 * ячейке (через `PurchaseReceiptLine.cellId`). Сознательная граница
 * MVP — нет полноценного складского остатка, нет MaterialStock /
 * FabricRoll / CellContent-записей, нет списания.
 *
 * Три контроллера (для разделения по доменам RBAC):
 *   - `PurchaseReceiptsController` — `/api/purchase-receipts/*`
 *     (CRUD-light, actions);
 *   - `PurchaseReceiptsPurchaseOrderController` —
 *     `/api/purchase-orders/:id/receipts`;
 *   - `PurchaseReceiptsOrderController` —
 *     `/api/orders/:id/purchase-receipts`.
 */
@Module({
  controllers: [
    PurchaseReceiptsController,
    PurchaseReceiptsPurchaseOrderController,
    PurchaseReceiptsOrderController,
  ],
  providers: [PurchaseReceiptsService, PurchaseReceiptNumberService],
  exports: [PurchaseReceiptsService],
})
export class PurchaseReceiptsModule {}
