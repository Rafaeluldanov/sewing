import { Module } from '@nestjs/common';
import { SalaryController } from './salary.controller.js';
import { SalaryService } from './salary.service.js';

/**
 * Модуль окладных начислений (post-Шаг 18 / Шаг 19, ADR-0021).
 *
 * Контракт — `docs/api.md §10a`. Бизнес-правила — `docs/domain.md §9a`.
 * Экспортирует `SalaryService`, чтобы `ShiftsModule` мог дёргать
 * `syncDailySalary` на старте/завершении смены.
 *
 * `AuditService` доступен через `@Global` `AuditModule` —
 * `SalaryService.updateManually` пишет `SALARY_ENTRY_UPDATED` /
 * `SALARY_ENTRY_RESET` в `AuditLog` (PHASE 2 STEP 4, см. JSDoc
 * метода, `docs/events.md`).
 */
@Module({
  controllers: [SalaryController],
  providers: [SalaryService],
  exports: [SalaryService],
})
export class SalaryModule {}
