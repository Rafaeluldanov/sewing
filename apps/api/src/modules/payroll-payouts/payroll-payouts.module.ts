import { Module } from '@nestjs/common';
import { PayrollPayoutsController } from './payroll-payouts.controller.js';
import { PayrollPayoutsService } from './payroll-payouts.service.js';

/**
 * Модуль «Выплаты зарплаты» (PHASE 3 STEP 2).
 *
 * Сервис формирует «папку выплаты» (`PayrollPayout`) поверх
 * существующих `OperationEntry` / `SalaryEntry`, не трогая ни
 * `EarningsService`, ни `SalaryService`. `AuditService` подтягивается
 * через глобальный `AuditModule`.
 *
 * Контракт — `docs/api.md §«Payroll payouts»`. Бизнес-инвариант
 * «строка не в двух активных выплатах одновременно» проверяется в
 * сервисе.
 */
@Module({
  controllers: [PayrollPayoutsController],
  providers: [PayrollPayoutsService],
})
export class PayrollPayoutsModule {}
