import {
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import {
  CreateFinishedGoodsShipmentSchema,
  type CreateFinishedGoodsShipmentDto,
} from './dto/create-finished-goods-shipment.dto.js';
import { FinishedGoodsService } from './finished-goods.service.js';

/**
 * `/api/orders/:orderId/finished-goods-shipments` — отгрузка готовой
 * продукции из карточки заказа (см.
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts::createShipmentForOrder`,
 * `prisma/schema.prisma::FinishedGoodsShipment` /
 * `FinishedGoodsShipmentLine`,
 * `docs/api.md §«Finished goods shipments»`).
 *
 * Контроллер вынесен из `OrdersController` сознательно (тот же паттерн,
 * что у `MaterialIssuesOrderController`): RBAC и DTO валидация для
 * shipment-flow живут в `FinishedGoodsModule`, а не в orders.
 *
 * RBAC — `ADMIN` / `SHOP_MANAGER`.
 */
@Controller('orders')
@Roles('ADMIN', 'SHOP_MANAGER')
export class FinishedGoodsOrderShipmentsController {
  constructor(private readonly finishedGoods: FinishedGoodsService) {}

  @Get(':orderId/finished-goods-shipments')
  listForOrder(@Param('orderId') orderId: string) {
    return this.finishedGoods.listShipmentsByOrder(orderId);
  }

  @Post(':orderId/finished-goods-shipments')
  createForOrder(
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(CreateFinishedGoodsShipmentSchema))
    dto: CreateFinishedGoodsShipmentDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.finishedGoods.createShipmentForOrder(
      orderId,
      dto,
      user.employeeId,
    );
  }
}
