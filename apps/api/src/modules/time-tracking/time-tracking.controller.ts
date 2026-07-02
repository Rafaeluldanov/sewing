import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  TimeTrackingQuerySchema,
  type TimeTrackingDto,
  type TimeTrackingQuery,
  type TimeTrackingSummaryDto,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import { TimeTrackingService } from './time-tracking.service.js';

/**
 * «Тайм-трекер сотрудника» — вкладка на карточке сотрудника
 * (`apps/web/app/admin/employees/[id]/time-tracker`).
 *
 *   GET /api/admin/employees/:id/time-tracking?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * RBAC: `SHOP_MANAGER`, `ADMIN` — тот же доступ, что у управления
 * сотрудниками (`EmployeesController`). Read-only.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('admin/employees')
export class TimeTrackingController {
  constructor(private readonly service: TimeTrackingService) {}

  /**
   * Обзор всех сотрудников за период (список-уровень вкладки). Статический
   * сегмент — объявлен ДО `:id/...`, чтобы `time-tracker-summary` не был
   * принят за `:id`.
   */
  @Get('time-tracker-summary')
  summary(
    @Query(new ZodValidationPipe(TimeTrackingQuerySchema))
    query: TimeTrackingQuery,
  ): Promise<TimeTrackingSummaryDto> {
    return this.service.getSummary(query);
  }

  @Get(':id/time-tracking')
  get(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(TimeTrackingQuerySchema))
    query: TimeTrackingQuery,
  ): Promise<TimeTrackingDto> {
    return this.service.getTimeTracking(id, query);
  }
}
