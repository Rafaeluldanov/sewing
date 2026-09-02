import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  CreateOrderCalculationSchema,
  RenameOrderCalculationSchema,
  type CreateOrderCalculationDto,
  type OrderCalculationsDto,
  type RenameOrderCalculationDto,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrderCalculationsService } from './order-calculations.service.js';

/**
 * REST-контракт фичи «Варианты просчёта заказа» под префиксом
 * `/api/orders/:id/calculations`. GET открыт любой авторизованной роли,
 * write-эндпоинты — менеджерам заказа (`ADMIN` / `SHOP_MANAGER`), как у
 * соседних расцветок (`order-colorways`).
 *
 * Все write-методы возвращают свежий полный `OrderCalculationsDto`,
 * чтобы UI обновлял ряд вкладок из одного источника.
 */
@Controller('orders/:id/calculations')
@MachineScopes('orders:read', 'orders:write')
export class OrderCalculationsController {
  constructor(private readonly service: OrderCalculationsService) {}

  @Get()
  list(@Param('id') orderId: string): Promise<OrderCalculationsDto> {
    return this.service.listForOrder(orderId);
  }

  /** «+ Вариант просчёта» — клон активного варианта. */
  @Post()
  @Roles('ADMIN', 'SHOP_MANAGER')
  create(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(CreateOrderCalculationSchema))
    dto: CreateOrderCalculationDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderCalculationsDto> {
    return this.service.create(orderId, dto, user.employeeId);
  }

  /** Переключение активного варианта (capture → restore → resync). */
  @Post(':calcId/activate')
  @Roles('ADMIN', 'SHOP_MANAGER')
  activate(
    @Param('id') orderId: string,
    @Param('calcId') calcId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderCalculationsDto> {
    return this.service.activate(orderId, calcId, user.employeeId);
  }

  @Patch(':calcId')
  @Roles('ADMIN', 'SHOP_MANAGER')
  rename(
    @Param('id') orderId: string,
    @Param('calcId') calcId: string,
    @Body(new ZodValidationPipe(RenameOrderCalculationSchema))
    dto: RenameOrderCalculationDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderCalculationsDto> {
    return this.service.rename(orderId, calcId, dto, user.employeeId);
  }

  @Delete(':calcId')
  @Roles('ADMIN', 'SHOP_MANAGER')
  remove(
    @Param('id') orderId: string,
    @Param('calcId') calcId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderCalculationsDto> {
    return this.service.remove(orderId, calcId, user.employeeId);
  }
}
