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
import { MaterialIssuesModule } from '../material-issues/material-issues.module.js';
import { CompanySettingsModule } from '../company-settings/company-settings.module.js';
import { FinishedGoodsModule } from '../finished-goods/finished-goods.module.js';
import { WorkInProgressModule } from '../work-in-progress/work-in-progress.module.js';

/**
 * Импортируем `EarningsModule`, чтобы `PassportsService` мог в одной
 * транзакции с `passport.create` и `passport.scanOnOperation` создавать
 * сдельные начисления (Шаг 9, ADR-0005).
 *
 * Импортируем `CuttingClosureModule`, чтобы `PassportsService.create`
 * мог проверять APPROVED-заявки на закрытие раскроя по размеру и
 * блокировать выпуск (ADR-0018, `docs/domain.md §15`).
 *
 * Импортируем `MaterialIssuesModule`, чтобы `PassportsService.issueToEmployee`
 * мог в той же транзакции создавать автоматический `MaterialIssue`
 * (автосписание материалов при выдаче кроя; см.
 * `apps/api/src/modules/material-issues/material-issues.service.ts::createAutoCutIssueForPassport`,
 * `docs/current-state.md §«Auto cut issue»`).
 *
 * Импортируем `CompanySettingsModule`, чтобы `PassportsService.issueToEmployee`
 * мог проверять hardening-флаг
 * `CompanySettings.autoIssueMaterialsOnCutRelease` перед вызовом
 * auto-helper (см. `CompanySettingsService.getAutoIssueMaterialsOnCutRelease`,
 * `docs/current-state.md §«Auto cut issue»`).
 */
@Module({
  imports: [
    EarningsModule,
    CuttingClosureModule,
    WarehousesModule,
    CutReleasePolicyModule,
    OrderCutIssueRulesModule,
    MaterialIssuesModule,
    CompanySettingsModule,
    // Foundation готовой продукции (см.
    // `apps/api/src/modules/finished-goods/finished-goods.service.ts`,
    // `prisma/schema.prisma::Operation.producesFinishedGoods`).
    // PassportsService при `scanOnOperation` /
    // `completeOperationByEmployee` фиксирует выпуск готовой продукции
    // (`PRODUCTION_RECEIPT IN`), если у пройденной операции стоит
    // `producesFinishedGoods = true`. Идемпотентно по
    // `sourceKey = PACKED_PASSPORT:<passportId>`.
    FinishedGoodsModule,
    // Foundation полуфабриката (см.
    // `apps/api/src/modules/work-in-progress/work-in-progress.service.ts`,
    // `prisma/schema.prisma::WorkInProgressBalance`/`WorkInProgressMovement`).
    // PassportsService при `place` / `issueToEmployee` / `delete`
    // фиксирует движения кроя в той же транзакции, что и обновление
    // CellContent / Passport.currentCellId. Идемпотентно по
    // `sourceKey = WIP_<TYPE>:<eventId|passportId>`.
    WorkInProgressModule,
  ],
  controllers: [PassportsController, OrderPassportsController, CellsController],
  providers: [PassportsService, PassportNumberService],
  // `PassportNumberService` экспортирован для модуля «Сигнальный
  // образец» (`apps/api/src/modules/order-samples/*`) — sample-flow
  // создаёт sample-passport напрямую (свой набор side-effects:
  // без enforce роли CUTTER, без immediate-начисления). Тиражным
  // паспортам по-прежнему служит `PassportsService.create`.
  exports: [PassportsService, PassportNumberService],
})
export class PassportsModule {}
