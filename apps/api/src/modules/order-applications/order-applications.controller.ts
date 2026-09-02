import {
  Body,
  Controller,
  Get,
  Param,
  Put,
} from '@nestjs/common';
import {
  ReplaceOrderApplicationsSchema,
  type ReplaceOrderApplicationsDto,
} from '@sewing/shared/order-applications';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrderApplicationsService } from './order-applications.service.js';

/**
 * `/api/orders/:id/applications` — нанесения конкретного заказа.
 *
 *   GET /api/orders/:id/applications  — список нанесений по заказу.
 *   PUT /api/orders/:id/applications  — full-replace списка нанесений
 *     (delete + createMany в одной транзакции). Менять можно только в
 *     `DRAFT` (см. `OrderApplicationsService.replaceForOrder`).
 *
 * Контроллер вынесен в отдельный модуль (а не пристроен к
 * `OrdersController`) сознательно: `OrdersController` уже носит
 * `@Roles('SHOP_MANAGER')` на классе и отдельную семантику CRUD
 * заказа, смешивать его с дочерними «Нанесениями» неудобно. Та же
 * схема, что у `WorkshopNeedsOrderController` и других вспомогательных
 * order-роутов.
 *
 * RBAC: `ADMIN` / `SHOP_MANAGER` — рабочим ролям нанесения не нужны.
 */
@Controller('orders')
@MachineScopes('orders:read')
@Roles('ADMIN', 'SHOP_MANAGER')
export class OrderApplicationsController {
  constructor(
    private readonly applications: OrderApplicationsService,
  ) {}

  @Get(':id/applications')
  list(@Param('id') orderId: string) {
    return this.applications.listForOrder(orderId);
  }

  @MachineScopes('orders:write')
  @Put(':id/applications')
  replace(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(ReplaceOrderApplicationsSchema))
    dto: ReplaceOrderApplicationsDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.applications.replaceForOrder(orderId, dto, user.employeeId);
  }
}
