import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  CreateOrderMaterialArrivalOverrideSchema,
  RevokeOrderMaterialArrivalOverrideSchema,
  type CreateOrderMaterialArrivalOverrideDto,
  type OrderMaterialArrivalOverrideDto,
  type RevokeOrderMaterialArrivalOverrideDto,
} from '@sewing/shared/order-material-arrivals';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrderMaterialArrivalsService } from './order-material-arrivals.service.js';

/**
 * `/api/orders/:orderId/material-arrived` и связанные ручные отметки
 * поступления материала (см.
 * `apps/api/src/modules/order-material-arrivals/order-material-arrivals.service.ts`,
 * `prisma/schema.prisma::OrderMaterialArrivalOverride`).
 *
 * Эндпоинты:
 *   POST /api/orders/:orderId/material-arrived
 *     — создать ручную отметку «Материал поступил».
 *   GET  /api/orders/:orderId/material-arrival-overrides
 *     — список ручных отметок по заказу (включая REVOKED).
 *   POST /api/orders/:orderId/material-arrival-overrides/:overrideId/revoke
 *     — отменить ручную отметку.
 *
 * RBAC:
 *   - на запись (POST): `ADMIN` / `SHOP_MANAGER` (защищено
 *     `@Roles` + дополнительной проверкой в сервисе);
 *   - на чтение (GET): дополнительно `CUTTER` / `CUTTER_ASSISTANT`,
 *     чтобы кройщик видел, что менеджер вручную разблокировал крой
 *     (та же логика, что в `CutReadinessController`).
 *
 * Контроллер живёт в собственном модуле, чтобы не пересекаться с
 * RBAC `OrdersController` и `CutReadinessController` (по тем же
 * причинам, что `PurchaseReceiptsOrderController`).
 */
@Controller('orders')
@Roles('ADMIN', 'SHOP_MANAGER', 'CUTTER', 'CUTTER_ASSISTANT')
export class OrderMaterialArrivalsController {
  constructor(
    private readonly service: OrderMaterialArrivalsService,
  ) {}

  @Get(':orderId/material-arrival-overrides')
  list(
    @Param('orderId') orderId: string,
  ): Promise<OrderMaterialArrivalOverrideDto[]> {
    return this.service.listForOrder(orderId);
  }

  @Post(':orderId/material-arrived')
  @HttpCode(HttpStatus.CREATED)
  markArrived(
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(CreateOrderMaterialArrivalOverrideSchema))
    body: CreateOrderMaterialArrivalOverrideDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderMaterialArrivalOverrideDto[]> {
    return this.service.markArrived(user, orderId, body);
  }

  @Post(':orderId/material-arrival-overrides/:overrideId/revoke')
  @HttpCode(HttpStatus.CREATED)
  revoke(
    @Param('orderId') orderId: string,
    @Param('overrideId') overrideId: string,
    @Body(new ZodValidationPipe(RevokeOrderMaterialArrivalOverrideSchema))
    body: RevokeOrderMaterialArrivalOverrideDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderMaterialArrivalOverrideDto> {
    return this.service.revoke(user, orderId, overrideId, body);
  }
}
