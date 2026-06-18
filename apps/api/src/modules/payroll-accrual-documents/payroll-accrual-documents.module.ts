import { Module } from '@nestjs/common';
import { TreasuryModule } from '../treasury/treasury.module.js';
import { PayrollAccrualDocumentsController } from './payroll-accrual-documents.controller.js';
import { PayrollAccrualDocumentsService } from './payroll-accrual-documents.service.js';

/**
 * Модуль «Документ начисления зарплаты» (PHASE 3 STEP 6.2).
 *
 * Менеджер формирует DRAFT-документ на дату (`accrualDate`): система
 * рассчитывает строки по `OperationEntry` / `SalaryEntry` с датой ≤
 * `accrualDate`. При проводке (`pay`) для каждой строки создаётся
 * индивидуальный `PayrollPayout` в статусе `ISSUED`.
 *
 * Контракт — `docs/api.md §«Payroll accrual documents»`.
 * Бизнес-смысл — `docs/domain.md §«Документ начисления зарплаты»`.
 * Аудит — `docs/events.md §«PAYROLL_ACCRUAL_DOCUMENT»`.
 * `AuditService` подключается через глобальный `AuditModule`.
 */
@Module({
  imports: [TreasuryModule],
  controllers: [PayrollAccrualDocumentsController],
  providers: [PayrollAccrualDocumentsService],
})
export class PayrollAccrualDocumentsModule {}
