import { Module } from '@nestjs/common';
import { PayrollAccrualDocumentsModule } from '../payroll-accrual-documents/payroll-accrual-documents.module.js';
import { PayrollScheduleController } from './payroll-schedule.controller.js';
import { PayrollScheduleService } from './payroll-schedule.service.js';

/**
 * Модуль «Расписание начисления зарплаты».
 *
 * Зависит от `PayrollAccrualDocumentsModule` в одну сторону: расписание
 * умеет создать черновик документа, но документ о расписании ничего не
 * знает — он берёт правило отсечки из чистого helper-а
 * `accrual-cutoff.ts`. Так цикла зависимостей не возникает.
 */
@Module({
  imports: [PayrollAccrualDocumentsModule],
  controllers: [PayrollScheduleController],
  providers: [PayrollScheduleService],
  exports: [PayrollScheduleService],
})
export class PayrollScheduleModule {}
