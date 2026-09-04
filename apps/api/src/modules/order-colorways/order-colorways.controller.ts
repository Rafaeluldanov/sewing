import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  UpsertOrderColorwaySchema,
  type OrderColorwaysDto,
  type UpsertOrderColorwayDto,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrderColorwaysService } from './order-colorways.service.js';

/**
 * REST-контракт фичи «Расцветки заказа» под префиксом
 * `/api/orders/:id/colorways`. GET открыт любой авторизованной роли,
 * write-эндпоинты — менеджерам заказа (`ADMIN` / `SHOP_MANAGER`).
 *
 * Все write-методы возвращают свежий полный `OrderColorwaysDto`, чтобы
 * UI обновлял состояние из одного источника (как `order-cut-issue-rules`).
 */
@Controller('orders/:id/colorways')
// Прямой шов: ERP создаёт заказ цеха с расцветками и должна узнать их id — по ним приход готовой
// продукции ложится ровно в ту строку заказа покупателя, из которой изделие заказано. Только
// чтение: расцветки правит цех.
@MachineScopes('orders:read')
export class OrderColorwaysController {
  constructor(private readonly service: OrderColorwaysService) {}

  @Get()
  list(@Param('id') orderId: string): Promise<OrderColorwaysDto> {
    return this.service.listForOrder(orderId);
  }

  @Post()
  @Roles('ADMIN', 'SHOP_MANAGER')
  create(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(UpsertOrderColorwaySchema))
    dto: UpsertOrderColorwayDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderColorwaysDto> {
    return this.service.create(orderId, dto, user.employeeId);
  }

  @Patch(':variantId')
  @Roles('ADMIN', 'SHOP_MANAGER')
  update(
    @Param('id') orderId: string,
    @Param('variantId') variantId: string,
    @Body(new ZodValidationPipe(UpsertOrderColorwaySchema))
    dto: UpsertOrderColorwayDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderColorwaysDto> {
    return this.service.update(orderId, variantId, dto, user.employeeId);
  }

  @Delete(':variantId')
  @Roles('ADMIN', 'SHOP_MANAGER')
  remove(
    @Param('id') orderId: string,
    @Param('variantId') variantId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderColorwaysDto> {
    return this.service.remove(orderId, variantId, user.employeeId);
  }
}
