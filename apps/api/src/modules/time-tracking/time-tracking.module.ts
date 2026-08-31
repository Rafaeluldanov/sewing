import { Module } from '@nestjs/common';
import { MasterEmployeeStatsModule } from '../master-employee-stats/master-employee-stats.module.js';
import { ShiftsModule } from '../shifts/shifts.module.js';
import { TimeTrackingController } from './time-tracking.controller.js';
import { TimeTrackingService } from './time-tracking.service.js';

/**
 * «Тайм-трекер сотрудника» (read-only). См.
 * `apps/api/src/modules/time-tracking/time-tracking.controller.ts`,
 * `packages/shared/src/time-tracking.ts`.
 *
 * `PrismaService` — из глобального `PrismaModule`. Импортируем
 * `MasterEmployeeStatsModule` ради `MasterEmployeeStatsService`
 * (переиспользуем finisher-attribution брака) и `ShiftsModule` ради
 * `ShiftAutoCloseService`: экран часов закрывает забытые смены до
 * расчёта, иначе показывал бы растянутые до полуночи цифры.
 */
@Module({
  imports: [MasterEmployeeStatsModule, ShiftsModule],
  controllers: [TimeTrackingController],
  providers: [TimeTrackingService],
})
export class TimeTrackingModule {}
