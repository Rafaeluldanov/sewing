import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  ForceCloseShiftSchema,
  MasterEmployeeStatsDrillQuerySchema,
  MasterEmployeeStatsQuerySchema,
  MasterUpdateEmployeeAccessSchema,
  type ForceCloseShiftDto,
  type MasterActiveShiftsDto,
  type MasterCloseShiftResultDto,
  type MasterEmployeeAccessDto,
  type MasterEmployeeAccessListDto,
  type MasterEmployeeDrillDto,
  type MasterEmployeeStatsDrillQuery,
  type MasterEmployeeStatsDto,
  type MasterEmployeeStatsQuery,
  type MasterUpdateEmployeeAccessDto,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { MasterEmployeeStatsService } from './master-employee-stats.service.js';

/**
 * «Статистика по сотрудникам» — кабинет мастера (вкладка «Сотрудники»,
 * `apps/web/app/master`).
 *
 *   GET  /api/master/employee-stats?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET  /api/master/employee-stats/drill?from&to&employeeId
 *   GET  /api/master/employee-stats/active-shifts
 *   POST /api/master/employee-stats/active-shifts/:shiftId/close
 *   GET  /api/master/employee-stats/access
 *   PUT  /api/master/employee-stats/access/:employeeId
 *
 * RBAC: `SHOPFLOOR_MASTER`, `SHOP_MANAGER`, `ADMIN` — тот же доступ,
 * что у экрана `/master` (`canSeeMasterPage`). Статистика и списки —
 * read-only; мутаций две: принудительное завершение смены (`close`,
 * аудит `MASTER_SHIFT_FORCE_CLOSED`) и смена участков сотрудника
 * (`access`, аудит `MASTER_EMPLOYEE_ROLES_UPDATED`) — последняя с
 * серверным белым списком цеховых ролей.
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

  /**
   * Режим «Активные»: открытые смены прямо сейчас (см.
   * `MasterEmployeeStatsService.getActiveShifts`).
   */
  @Get('active-shifts')
  activeShifts(): Promise<MasterActiveShiftsDto> {
    return this.service.getActiveShifts();
  }

  /**
   * Принудительное завершение смены мастером (см.
   * `MasterEmployeeStatsService.closeActiveShift`): уже закрытая смена —
   * успех-noop, паспорта на руках без `force` —
   * `409 SHIFT_HAS_ACTIVE_PASSPORTS`.
   */
  @Post('active-shifts/:shiftId/close')
  closeActiveShift(
    @CurrentUser() user: AuthPrincipal,
    @Param('shiftId') shiftId: string,
    @Body(new ZodValidationPipe(ForceCloseShiftSchema))
    dto: ForceCloseShiftDto,
  ): Promise<MasterCloseShiftResultDto> {
    return this.service.closeActiveShift(user, shiftId, dto);
  }

  /**
   * Режим «Доступы»: активные сотрудники и их участки (см.
   * `MasterEmployeeStatsService.listAccess`).
   */
  @Get('access')
  access(): Promise<MasterEmployeeAccessListDto> {
    return this.service.listAccess();
  }

  /**
   * Мастер меняет набор участков сотрудника. Узкий контракт вместо
   * `PATCH /api/employees/:id` (там же зарплата, PIN, архив): только
   * роли и только из белого списка `MASTER_ASSIGNABLE_ROLES` — см.
   * `MasterEmployeeStatsService.updateAccess`.
   */
  @Put('access/:employeeId')
  updateAccess(
    @CurrentUser() user: AuthPrincipal,
    @Param('employeeId') employeeId: string,
    @Body(new ZodValidationPipe(MasterUpdateEmployeeAccessSchema))
    dto: MasterUpdateEmployeeAccessDto,
  ): Promise<MasterEmployeeAccessDto> {
    return this.service.updateAccess(user, employeeId, dto);
  }
}
