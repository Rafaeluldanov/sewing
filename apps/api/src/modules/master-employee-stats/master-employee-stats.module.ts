import { Module } from '@nestjs/common';
import { MasterEmployeeStatsController } from './master-employee-stats.controller.js';
import { MasterEmployeeStatsService } from './master-employee-stats.service.js';

/**
 * «Статистика по сотрудникам» для кабинета мастера (read-only).
 *
 * См. `apps/api/src/modules/master-employee-stats/master-employee-stats.controller.ts`,
 * `packages/shared/src/master-employee-stats.ts`, вкладку «Сотрудники»
 * в `apps/web/app/master`.
 *
 * `PrismaService` инжектится через глобальный `PrismaModule` — отдельные
 * `imports` не требуются.
 */
@Module({
  controllers: [MasterEmployeeStatsController],
  providers: [MasterEmployeeStatsService],
  exports: [MasterEmployeeStatsService],
})
export class MasterEmployeeStatsModule {}
