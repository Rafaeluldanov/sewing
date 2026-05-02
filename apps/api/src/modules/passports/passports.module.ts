import { Module } from '@nestjs/common';
import { PassportsService } from './passports.service.js';
import { PassportNumberService } from './passport-number.service.js';
import { PassportsController } from './passports.controller.js';
import { OrderPassportsController } from './order-passports.controller.js';
import { CellsController } from './cells.controller.js';
import { EarningsModule } from '../earnings/earnings.module.js';
import { CuttingClosureModule } from '../cutting-closure/cutting-closure.module.js';
import { WarehousesModule } from '../warehouses/warehouses.module.js';
import { CutReleasePolicyModule } from '../cut-release-policy/cut-release-policy.module.js';
import { OrderCutIssueRulesModule } from '../order-cut-issue-rules/order-cut-issue-rules.module.js';

/**
 * Импортируем `EarningsModule`, чтобы `PassportsService` мог в одной
 * транзакции с `passport.create` и `passport.scanOnOperation` создавать
 * сдельные начисления (Шаг 9, ADR-0005).
 *
 * Импортируем `CuttingClosureModule`, чтобы `PassportsService.create`
 * мог проверять APPROVED-заявки на закрытие раскроя по размеру и
 * блокировать выпуск (ADR-0018, `docs/domain.md §15`).
 */
@Module({
  imports: [
    EarningsModule,
    CuttingClosureModule,
    WarehousesModule,
    CutReleasePolicyModule,
    OrderCutIssueRulesModule,
  ],
  controllers: [PassportsController, OrderPassportsController, CellsController],
  providers: [PassportsService, PassportNumberService],
  exports: [PassportsService],
})
export class PassportsModule {}
