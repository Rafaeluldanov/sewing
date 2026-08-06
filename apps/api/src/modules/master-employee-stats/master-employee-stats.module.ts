import { Module } from '@nestjs/common';
import { ShiftsModule } from '../shifts/shifts.module.js';
import { MasterEmployeeStatsController } from './master-employee-stats.controller.js';
import { MasterEmployeeStatsService } from './master-employee-stats.service.js';

/**
 * «Статистика по сотрудникам» для кабинета мастера: агрегаты «кто
 * сколько сделал» (read-only) + режим «Активные» — список открытых смен
 * с принудительным завершением мастером.
 *
 * См. `apps/api/src/modules/master-employee-stats/master-employee-stats.controller.ts`,
 * `packages/shared/src/master-employee-stats.ts`, вкладку «Сотрудники»
 * в `apps/web/app/master`.
 *
 * `ShiftsModule` импортируется ради `ShiftsService.stop` — закрытие
 * смены идёт тем же путём, что и самозакрытие сотрудником (в т.ч.
 * `safeSyncSalary`, оклад выравнивается сам). `PrismaService` и
 * `AuditService` инжектятся через глобальные модули (`PrismaModule` /
 * `AuditModule` помечены `@Global()`) — отдельные `imports` не требуются.
 */
@Module({
  imports: [ShiftsModule],
  controllers: [MasterEmployeeStatsController],
  providers: [MasterEmployeeStatsService],
  exports: [MasterEmployeeStatsService],
})
export class MasterEmployeeStatsModule {}
