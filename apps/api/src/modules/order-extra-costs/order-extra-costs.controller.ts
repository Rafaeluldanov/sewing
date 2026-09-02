import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CreateOrderExtraCostSchema,
  UpdateOrderExtraCostSchema,
  type CreateOrderExtraCostDto,
  type OrderExtraCostDto,
  type UpdateOrderExtraCostDto,
} from '@sewing/shared/order-extra-costs';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrderExtraCostsService } from './order-extra-costs.service.js';

/**
 * `/api/orders/:orderId/extra-costs/*` — прочие / непредвиденные расходы
 * заказа (этап «Корректировка материалов после просчёта»).
 *
 *   GET    /api/orders/:orderId/extra-costs            — список
 *   POST   /api/orders/:orderId/extra-costs            — добавить
 *   PATCH  /api/orders/:orderId/extra-costs/:costId    — править
 *   DELETE /api/orders/:orderId/extra-costs/:costId    — удалить
 *
 * RBAC: `ADMIN` / `SHOP_MANAGER`. Контроллер живёт в собственном модуле
 * (а не в `OrdersController`), чтобы не расширять его матрицу ролей и
 * CRUD-семантику — по тем же причинам, что `OrderMaterialArrivalsController`.
 */
@Controller('orders')
@MachineScopes('orders:read')
@Roles('ADMIN', 'SHOP_MANAGER')
export class OrderExtraCostsController {
  constructor(private readonly service: OrderExtraCostsService) {}

  @Get(':orderId/extra-costs')
  list(@Param('orderId') orderId: string): Promise<OrderExtraCostDto[]> {
    return this.service.listForOrder(orderId);
  }

  @MachineScopes('orders:write')
  @Post(':orderId/extra-costs')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(CreateOrderExtraCostSchema))
    dto: CreateOrderExtraCostDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderExtraCostDto> {
    return this.service.create(orderId, dto, user.employeeId);
  }

  @MachineScopes('orders:write')
  @Patch(':orderId/extra-costs/:costId')
  update(
    @Param('costId') costId: string,
    @Body(new ZodValidationPipe(UpdateOrderExtraCostSchema))
    dto: UpdateOrderExtraCostDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderExtraCostDto> {
    return this.service.update(costId, dto, user.employeeId);
  }

  @MachineScopes('orders:write')
  @Delete(':orderId/extra-costs/:costId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('costId') costId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<void> {
    await this.service.delete(costId, user.employeeId);
  }
}
