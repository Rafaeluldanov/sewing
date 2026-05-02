import { Module } from '@nestjs/common';
import { PayrollController } from './payroll.controller.js';
import { PayrollService } from './payroll.service.js';

/**
 * Модуль Payroll (PHASE 1, read-only).
 *
 * Контракт — `docs/api.md §10c`. Бизнес-правила —
 * `docs/domain.md §10.6`. Экраны — `docs/screens.md §12a`.
 *
 * Сервис **только читает** уже существующие таблицы (`OperationEntry`,
 * `SalaryEntry`, `ShiftSession`, `Employee`, `Order.companyDivision`)
 * и собирает агрегаты под управленческий UI зарплаты.
 *
 * Намеренно **не экспортирует** `PayrollService`: никакому другому
 * модулю он не нужен — это чистая read-API-обёртка над уже
 * существующими источниками истины. Если в PHASE 2 появятся ledger /
 * recalc / approval flow — они уйдут в новые сервисы, а этот
 * read-агрегатор останется компактной точкой просмотра.
 */
@Module({
  controllers: [PayrollController],
  providers: [PayrollService],
})
export class PayrollModule {}
