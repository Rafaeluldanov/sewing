import { Controller, Get, Query } from '@nestjs/common';
import {
  MasterEmployeeStatsDrillQuerySchema,
  MasterEmployeeStatsQuerySchema,
  type MasterEmployeeDrillDto,
  type MasterEmployeeStatsDrillQuery,
  type MasterEmployeeStatsDto,
  type MasterEmployeeStatsQuery,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import { MasterEmployeeStatsService } from './master-employee-stats.service.js';

/**
 * «Статистика по сотрудникам» — кабинет мастера (вкладка «Сотрудники»,
 * `apps/web/app/master`).
 *
 *   GET /api/master/employee-stats?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET /api/master/employee-stats/drill?from&to&employeeId
 *
 * RBAC: `SHOPFLOOR_MASTER`, `SHOP_MANAGER`, `ADMIN` — тот же доступ,
 * что у экрана `/master` (`canSeeMasterPage`). Read-only.
 */
@Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN')
@Controller('master/employee-stats')
export class MasterEmployeeStatsController {
  constructor(private readonly service: MasterEmployeeStatsService) {}

  @Get()
  stats(
    @Query(new ZodValidationPipe(MasterEmployeeStatsQuerySchema))
    query: MasterEmployeeStatsQuery,
  ): Promise<MasterEmployeeStatsDto> {
    return this.service.getStats(query);
  }

  @Get('drill')
  drill(
    @Query(new ZodValidationPipe(MasterEmployeeStatsDrillQuerySchema))
    query: MasterEmployeeStatsDrillQuery,
  ): Promise<MasterEmployeeDrillDto> {
    return this.service.getDrill(query);
  }
}
