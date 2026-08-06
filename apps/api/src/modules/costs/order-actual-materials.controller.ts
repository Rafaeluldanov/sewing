import { Controller, Get, Query } from '@nestjs/common';
import {
  OrderActualMaterialsQuerySchema,
  type OrderActualMaterialsQuery,
} from '@sewing/shared/order-actual-materials';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import { OrderActualMaterialsService } from './order-actual-materials.service.js';

/**
 * Отчёт «Материалы: план → факт по заказу» (Себестоимость, Фаза 2).
 *
 *   GET /api/costs/actual-materials?dateFrom=&dateTo=
 *
 * Период — окно проводок пула накладных. Без него накладные не
 * распределяются вовсе (см. `OrderActualMaterialsReportDto.overheadPeriod`).
 *
 * Read-only, RBAC `SHOP_MANAGER`/`ADMIN`. Себестоимость потребляет факт
 * приёмок; проводок не пишет.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('costs')
export class OrderActualMaterialsController {
  constructor(private readonly service: OrderActualMaterialsService) {}

  @Get('actual-materials')
  getReport(
    @Query(new ZodValidationPipe(OrderActualMaterialsQuerySchema))
    query: OrderActualMaterialsQuery,
  ) {
    return this.service.getReport(query);
  }
}
