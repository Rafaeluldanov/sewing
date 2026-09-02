import { Controller, Get, Query } from '@nestjs/common';
import {
  ProductionDashboardQuerySchema,
  type ProductionDashboardDto,
  type ProductionDashboardQuery,
} from '@sewing/shared/dashboard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { MachineScopes, Roles } from '../auth/auth.decorators.js';
import { DashboardService } from './dashboard.service.js';

/**
 * REST-вход дашборда начальника производства (`docs/api.md §11b`).
 *
 *   GET /api/dashboard/production?days=7|14|30
 *
 * Доступ — `SHOP_MANAGER`, `ADMIN` и read-only `DISPLAY` (экран цеха
 * на большом мониторе, см. `apps/web/app/shopfloor/display/page.tsx`).
 * Backend = источник истины для всех KPI/агрегатов; UI делает только
 * разметку. DISPLAY не получает никаких мутаций — у роли вообще нет
 * прав на запись по системе.
 */
@Roles('SHOP_MANAGER', 'ADMIN', 'DISPLAY')
@Controller('dashboard')
@MachineScopes('dashboard:read')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('production')
  productionDashboard(
    @Query(new ZodValidationPipe(ProductionDashboardQuerySchema))
    query: ProductionDashboardQuery,
  ): Promise<ProductionDashboardDto> {
    return this.dashboard.getProductionDashboard(query);
  }
}
