import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ConfirmPurchaseOrderSchema,
  CreatePurchaseOrderFromNeedsSchema,
  ListPurchaseOrdersQuerySchema,
  UpdatePurchaseOrderLineSchema,
  UpdatePurchaseOrderSchema,
  type ConfirmPurchaseOrderDto,
  type CreatePurchaseOrderFromNeedsDto,
  type ListPurchaseOrdersQuery,
  type UpdatePurchaseOrderDto,
  type UpdatePurchaseOrderLineDto,
} from '@sewing/shared/purchase-orders';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';

/**
 * `/api/purchase-orders` — закупочный документ (Этап 6А, см.
 * `docs/recon-soft-integration.md §«Этап 6А»`).
 *
 *   GET    /api/purchase-orders
 *   GET    /api/purchase-orders/:id
 *   POST   /api/purchase-orders/from-needs
 *   PATCH  /api/purchase-orders/:id
 *   PATCH  /api/purchase-orders/:id/lines/:lineId
 *   POST   /api/purchase-orders/:id/send
 *   POST   /api/purchase-orders/:id/confirm
 *   POST   /api/purchase-orders/:id/reopen
 *   POST   /api/purchase-orders/:id/cancel
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER` (новые роли сознательно не вводим).
 *
 * Доп. эндпоинт `GET /api/orders/:id/purchase-orders` живёт в
 * отдельном `PurchaseOrdersOrderController`, чтобы не пересекаться
 * с RBAC `OrdersController` (`@Roles('SHOP_MANAGER')` на классе).
 */
@Controller('purchase-orders')
@Roles('ADMIN', 'SHOP_MANAGER')
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrders: PurchaseOrdersService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListPurchaseOrdersQuerySchema))
    query: ListPurchaseOrdersQuery,
  ) {
    return this.purchaseOrders.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.purchaseOrders.get(id);
  }

  @Post('from-needs')
  @HttpCode(HttpStatus.CREATED)
  createFromNeeds(
    @Body(new ZodValidationPipe(CreatePurchaseOrderFromNeedsSchema))
    body: CreatePurchaseOrderFromNeedsDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.purchaseOrders.createFromNeeds(body, user.employeeId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePurchaseOrderSchema))
    body: UpdatePurchaseOrderDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.purchaseOrders.update(id, body, user.employeeId);
  }

  @Patch(':id/lines/:lineId')
  updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body(new ZodValidationPipe(UpdatePurchaseOrderLineSchema))
    body: UpdatePurchaseOrderLineDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.purchaseOrders.updateLine(id, lineId, body, user.employeeId);
  }

  @Post(':id/send')
  send(@Param('id') id: string, @CurrentUser() user: AuthPrincipal) {
    return this.purchaseOrders.send(id, user.employeeId);
  }

  @Post(':id/confirm')
  confirm(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ConfirmPurchaseOrderSchema))
    body: ConfirmPurchaseOrderDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.purchaseOrders.confirm(id, body, user.employeeId);
  }

  @Post(':id/reopen')
  reopen(@Param('id') id: string, @CurrentUser() user: AuthPrincipal) {
    return this.purchaseOrders.reopen(id, user.employeeId);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthPrincipal) {
    return this.purchaseOrders.cancel(id, user.employeeId);
  }
}
