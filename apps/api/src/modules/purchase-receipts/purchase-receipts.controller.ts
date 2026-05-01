import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  CancelPurchaseReceiptSchema,
  CreatePurchaseReceiptFromPurchaseOrderSchema,
  ListPurchaseReceiptsQuerySchema,
  type CancelPurchaseReceiptDto,
  type CreatePurchaseReceiptFromPurchaseOrderDto,
  type ListPurchaseReceiptsQuery,
} from '@sewing/shared/purchase-receipts';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PurchaseReceiptsService } from './purchase-receipts.service.js';

/**
 * `/api/purchase-receipts` — фактическая приёмка по `PurchaseOrder`
 * (Этап 7А, см. `docs/recon-soft-integration.md §«Этап 7А»`).
 *
 *   GET    /api/purchase-receipts
 *   GET    /api/purchase-receipts/:id
 *   POST   /api/purchase-receipts/from-purchase-order
 *   POST   /api/purchase-receipts/:id/cancel
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER` (новые роли сознательно не вводим).
 *
 * Доп. эндпоинты (`/api/purchase-orders/:id/receipts`,
 * `/api/orders/:id/purchase-receipts`) живут в отдельных
 * контроллерах ниже, чтобы не пересекаться с RBAC соответствующих
 * модулей (`PurchaseOrdersController`, `OrdersController`).
 */
@Controller('purchase-receipts')
@Roles('ADMIN', 'SHOP_MANAGER')
export class PurchaseReceiptsController {
  constructor(private readonly purchaseReceipts: PurchaseReceiptsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListPurchaseReceiptsQuerySchema))
    query: ListPurchaseReceiptsQuery,
  ) {
    return this.purchaseReceipts.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.purchaseReceipts.get(id);
  }

  @Post('from-purchase-order')
  @HttpCode(HttpStatus.CREATED)
  createFromPurchaseOrder(
    @Body(new ZodValidationPipe(CreatePurchaseReceiptFromPurchaseOrderSchema))
    body: CreatePurchaseReceiptFromPurchaseOrderDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.purchaseReceipts.createFromPurchaseOrder(
      body,
      user.employeeId,
    );
  }

  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelPurchaseReceiptSchema))
    body: CancelPurchaseReceiptDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.purchaseReceipts.cancel(id, body, user.employeeId);
  }
}
