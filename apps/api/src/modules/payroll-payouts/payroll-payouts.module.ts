import { Module } from '@nestjs/common';
import { PayrollPayoutsController } from './payroll-payouts.controller.js';
import { PayrollPayoutsService } from './payroll-payouts.service.js';
import { TreasuryModule } from '../treasury/treasury.module.js';

/**
 * Модуль «Выплаты зарплаты» (PHASE 3 STEP 2).
 *
 * Сервис формирует «папку выплаты» (`PayrollPayout`) поверх
 * существующих `OperationEntry` / `SalaryEntry`, не трогая ни
 * `EarningsService`, ни `SalaryService`. `AuditService` подтягивается
 * через глобальный `AuditModule`.
 *
 * Казначейство (Фаза 1): импортируем `TreasuryModule`, чтобы при выдаче
 * выплаты (опт-ин — если задан зарплатный счёт) писать проводку журнала
 * ДС, а при отмене выданной — сторнировать её. `EarningsService`/
 * `SalaryService` не затрагиваются.
 *
 * Контракт — `docs/api.md §«Payroll payouts»`. Бизнес-инвариант
 * «строка не в двух активных выплатах одновременно» проверяется в
 * сервисе.
 */
@Module({
  imports: [TreasuryModule],
  controllers: [PayrollPayoutsController],
  providers: [PayrollPayoutsService],
})
export class PayrollPayoutsModule {}
