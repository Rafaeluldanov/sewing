import {
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';

import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { OrderSamplesService } from './order-samples.service.js';
import {
  StartOrderSampleSchema,
  type StartOrderSampleDto,
} from './dto/start-order-sample.dto.js';
import {
  ApproveOrderSampleSchema,
  CancelOrderSampleSchema,
  RejectOrderSampleSchema,
  type ApproveOrderSampleDto,
  type CancelOrderSampleDto,
  type RejectOrderSampleDto,
} from './dto/approve-order-sample.dto.js';

/**
 * Подресурс заказа: запуск и list сигнальных образцов.
 *
 * См. `apps/api/src/modules/order-samples/order-samples.service.ts`,
 * `docs/order-signal-sample-flow.md`.
 *
 * RBAC:
 *   - `POST /api/orders/:id/samples/start` — `SHOP_MANAGER`,
 *     `CUTTER_ASSISTANT` (ADMIN глобально). Помощник раскройщика
 *     уже выпускает обычные паспорта — пусть тем же контуром
 *     запускает образец.
 *   - `GET /api/orders/:id/samples` — те же роли + `CUTTER`,
 *     `SHOPFLOOR_MASTER` для чтения.
 */
@Controller('orders')
@MachineScopes('orders:read')
export class OrderSamplesOrderController {
  constructor(private readonly samples: OrderSamplesService) {}

  @MachineScopes('orders:write')
  @Post(':orderId/samples/start')
  @Roles('SHOP_MANAGER', 'CUTTER_ASSISTANT')
  start(
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(StartOrderSampleSchema)) dto: StartOrderSampleDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.samples.start(orderId, dto, user.employeeId, user.role);
  }

  @Get(':orderId/samples')
  @Roles('SHOP_MANAGER', 'CUTTER_ASSISTANT', 'CUTTER', 'SHOPFLOOR_MASTER')
  list(@Param('orderId') orderId: string) {
    return this.samples.listByOrder(orderId);
  }
}

/**
 * Корневой контроллер `OrderSample`: read-one + action endpoints
 * (approve / reject / cancel). RBAC:
 *   - read — `SHOP_MANAGER`, `CUTTER_ASSISTANT`, `CUTTER`,
 *     `SHOPFLOOR_MASTER`, `ADMIN`.
 *   - approve / reject / cancel — `SHOP_MANAGER` (`ADMIN` глобально).
 */
@Controller('order-samples')
@MachineScopes('orders:read')
export class OrderSamplesController {
  constructor(private readonly samples: OrderSamplesService) {}

  @Get(':id')
  @Roles('SHOP_MANAGER', 'CUTTER_ASSISTANT', 'CUTTER', 'SHOPFLOOR_MASTER')
  getOne(@Param('id') id: string) {
    return this.samples.getOne(id);
  }

  @MachineScopes('orders:write')
  @Post(':id/approve')
  @Roles('SHOP_MANAGER')
  approve(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ApproveOrderSampleSchema)) dto: ApproveOrderSampleDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.samples.approve(id, dto, user.employeeId);
  }

  @MachineScopes('orders:write')
  @Post(':id/reject')
  @Roles('SHOP_MANAGER')
  reject(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectOrderSampleSchema)) dto: RejectOrderSampleDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.samples.reject(id, dto, user.employeeId);
  }

  @MachineScopes('orders:write')
  @Post(':id/cancel')
  @Roles('SHOP_MANAGER')
  cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelOrderSampleSchema)) dto: CancelOrderSampleDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.samples.cancel(id, dto, user.employeeId);
  }
}
