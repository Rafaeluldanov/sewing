import { Controller, Get, Param } from '@nestjs/common';
import { PassportsService } from './passports.service.js';
import { MachineScopes, Roles } from '../auth/auth.decorators.js';

/**
 * Подресурс заказа: список паспортов конкретного заказа.
 *
 * Вынесен в отдельный контроллер, чтобы не размазывать тематику между
 * `OrdersController` и `PassportsController` и сохранить «orders module»
 * в покое (см. требования Шага 5).
 *
 * RBAC. Эндпоинт смонтирован под `/api/orders/...` и считается частью
 * раздела «Заказы» — ограничен теми же ролями, что и read-эндпоинты в
 * `OrdersController`: `SHOP_MANAGER`, `CUTTER_ASSISTANT` (последний —
 * чтобы помощник раскройщика мог увидеть уже выпущенные паспорта при
 * выпуске нового), `ADMIN` через `RolesGuard`.
 */
@Controller('orders')
@Roles('SHOP_MANAGER', 'CUTTER_ASSISTANT', 'CUTTER')
export class OrderPassportsController {
  constructor(private readonly passports: PassportsService) {}

  // Паспорта заказа: основание строк документа производства ERP. Без них в сдаче виден
  // только номер паспорта строкой, а открыть его нечем.
  @MachineScopes('orders:read')
  @Get(':id/passports')
  list(@Param('id') id: string) {
    return this.passports.listByOrder(id);
  }
}
