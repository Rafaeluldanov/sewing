import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Put,
  Query,
} from '@nestjs/common';
import {
  ListPayrollCalendarQuerySchema,
  UpsertPayrollCalendarMonthSchema,
  type ListPayrollCalendarQuery,
  type UpsertPayrollCalendarMonthDto,
} from '@sewing/shared/payroll-calendar';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PayrollCalendarService } from './payroll-calendar.service.js';

/**
 * Контроллер производственного календаря (см. `docs/api.md §31a`).
 *
 *   GET    /api/payroll-calendar?year=2026   — нормы месяцев
 *   PUT    /api/payroll-calendar             — upsert строки месяца
 *   DELETE /api/payroll-calendar/:year/:month — убрать строку
 *
 * RBAC — `SHOP_MANAGER` / `ADMIN`: норма часов участвует в расчёте
 * денег (производная ставка месячного окладника), поэтому доступ
 * тот же, что у ручной правки начислений.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('payroll-calendar')
export class PayrollCalendarController {
  constructor(private readonly calendar: PayrollCalendarService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListPayrollCalendarQuerySchema))
    query: ListPayrollCalendarQuery,
  ) {
    return this.calendar.list(query);
  }

  @Put()
  upsert(
    @Body(new ZodValidationPipe(UpsertPayrollCalendarMonthSchema))
    body: UpsertPayrollCalendarMonthDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.calendar.upsert(body, user.employeeId);
  }

  @Delete(':year/:month')
  remove(
    @Param('year', ParseIntPipe) year: number,
    @Param('month', ParseIntPipe) month: number,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.calendar.remove(year, month, user.employeeId);
  }
}
