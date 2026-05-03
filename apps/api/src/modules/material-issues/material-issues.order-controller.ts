import { Controller, Get, Param } from '@nestjs/common';

import { Roles } from '../auth/auth.decorators.js';
import { MaterialIssuesService } from './material-issues.service.js';

/**
 * `/api/orders/:orderId/material-issues` — список документов
 * фактического расхода материалов по конкретному заказу.
 *
 * Контроллер вынесен из `OrdersController` сознательно (тот же
 * паттерн, что у `WorkshopNeedsOrderController` /
 * `PurchaseReceiptsOrderController`):
 *   - `OrdersController` имеет своё RBAC-перекрытие и отдельную
 *     семантику CRUD-заказа;
 *   - все material-issue-роуты живут в `MaterialIssuesModule`.
 *
 * RBAC — `ADMIN` / `SHOP_MANAGER`.
 */
@Controller('orders')
@Roles('ADMIN', 'SHOP_MANAGER')
export class MaterialIssuesOrderController {
  constructor(private readonly materialIssues: MaterialIssuesService) {}

  @Get(':orderId/material-issues')
  listForOrder(@Param('orderId') orderId: string) {
    return this.materialIssues.listByOrder(orderId);
  }
}
