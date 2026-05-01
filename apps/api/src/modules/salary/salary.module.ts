import { Module } from '@nestjs/common';
import { SalaryController } from './salary.controller.js';
import { SalaryService } from './salary.service.js';

/**
 * Модуль окладных начислений (post-Шаг 18 / Шаг 19, ADR-0021).
 *
 * Контракт — `docs/api.md §10a`. Бизнес-правила — `docs/domain.md §9a`.
 * Экспортирует `SalaryService`, чтобы `ShiftsModule` мог дёргать
 * `syncDailySalary` на старте/завершении смены.
 */
@Module({
  controllers: [SalaryController],
  providers: [SalaryService],
  exports: [SalaryService],
})
export class SalaryModule {}
