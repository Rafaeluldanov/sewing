import { Module } from '@nestjs/common';
import { MasterEmployeeStatsModule } from '../master-employee-stats/master-employee-stats.module.js';
import { TimeTrackingController } from './time-tracking.controller.js';
import { TimeTrackingService } from './time-tracking.service.js';

/**
 * «Тайм-трекер сотрудника» (read-only). См.
 * `apps/api/src/modules/time-tracking/time-tracking.controller.ts`,
 * `packages/shared/src/time-tracking.ts`.
 *
 * `PrismaService` — из глобального `PrismaModule`. Импортируем
 * `MasterEmployeeStatsModule` ради `MasterEmployeeStatsService`
 * (переиспользуем finisher-attribution брака).
 */
@Module({
  imports: [MasterEmployeeStatsModule],
  controllers: [TimeTrackingController],
  providers: [TimeTrackingService],
})
export class TimeTrackingModule {}
