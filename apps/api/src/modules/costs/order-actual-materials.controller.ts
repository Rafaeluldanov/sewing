import { Controller, Get } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators.js';
import { OrderActualMaterialsService } from './order-actual-materials.service.js';

/**
 * Отчёт «Материалы: план → факт по заказу» (Себестоимость, Фаза 2).
 *
 *   GET /api/costs/actual-materials
 *
 * Read-only, RBAC `SHOP_MANAGER`/`ADMIN`. Себестоимость потребляет факт
 * приёмок; проводок не пишет.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('costs')
export class OrderActualMaterialsController {
  constructor(private readonly service: OrderActualMaterialsService) {}

  @Get('actual-materials')
  getReport() {
    return this.service.getReport();
  }
}
