import { Module } from '@nestjs/common';
import { OrderCutIssueRulesModule } from '../order-cut-issue-rules/order-cut-issue-rules.module.js';
import { WorkInProgressModule } from '../work-in-progress/work-in-progress.module.js';
import { QcModule } from '../qc/qc.module.js';
import { PassportQtyCorrectionsModule } from '../passport-qty-corrections/passport-qty-corrections.module.js';
import { MasterActionsController } from './master-actions.controller.js';
import { MasterActionsService } from './master-actions.service.js';

/**
 * Stage 2 «Мастер цеха» — ручные действия мастера над паспортами кроя.
 *
 * См. `docs/domain.md §«Действия мастера»`,
 * `docs/flows.md §«F-Master actions»`,
 * `docs/screens.md §«/master mobile actions UI»`,
 * `apps/api/src/modules/master-actions/master-actions.controller.ts`.
 *
 * `AuditService` и `PrismaService` инжектятся через глобальные модули
 * (`AuditModule` / `PrismaModule` помечены `@Global()`), отдельные
 * `imports` не требуются.
 *
 * `QcModule` импортируется ради `QcService`: ОТК-действия мастера
 * («зафиксировать брак» / «вернуть на доработку», см.
 * `master-actions.controller.ts`) переиспользуют ту же бизнес-логику,
 * что и роль `QC` на `/qc`, — единый источник правды по дефектам и
 * возвратам (`QcService.recordDefect` / `returnToRework`).
 *
 * `PassportQtyCorrectionsModule` — ради `PassportQtyCorrectionsService`:
 * одношаговая корректировка количества мастером
 * (`applyByMaster`) применяет те же транзакционные шаги, что и approve
 * заявки ОТК.
 */
@Module({
  imports: [
    OrderCutIssueRulesModule,
    WorkInProgressModule,
    QcModule,
    PassportQtyCorrectionsModule,
  ],
  controllers: [MasterActionsController],
  providers: [MasterActionsService],
  exports: [MasterActionsService],
})
export class MasterActionsModule {}
