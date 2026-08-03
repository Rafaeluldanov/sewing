import { Controller, Get, Query } from '@nestjs/common';
import {
  MasterOrdersQuerySchema,
  type MasterOrdersDto,
  type MasterOrdersQuery,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import { MasterOrdersService } from './master-orders.service.js';

/**
 * Вкладка «Заказы» кабинета мастера (`apps/web/app/master`).
 *
 *   GET /api/master/orders?tab=production|pending|done[&search=…]
 *
 * RBAC: `SHOPFLOOR_MASTER`, `SHOP_MANAGER`, `ADMIN` — тот же доступ, что
 * у остальных ручек кабинета (`master/production-board`,
 * `master/employee-stats`) и у самого экрана (`canSeeMasterPage`).
 *
 * Ручка узкая намеренно: общий `GET /orders` отдаёт управленческий DTO
 * (себестоимость, склад, freshness плана) и закрыт `SHOP_MANAGER`. Мастеру
 * нужен цеховой срез — номер, изделие, срок, прогресс, маршрут.
 */
@Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN')
@Controller('master/orders')
export class MasterOrdersController {
  constructor(private readonly service: MasterOrdersService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(MasterOrdersQuerySchema))
    query: MasterOrdersQuery,
  ): Promise<MasterOrdersDto> {
    return this.service.list(query);
  }
}
