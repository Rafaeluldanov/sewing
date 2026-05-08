import { Module } from '@nestjs/common';
import { OrderCutIssueRulesModule } from '../order-cut-issue-rules/order-cut-issue-rules.module.js';
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
 */
@Module({
  imports: [OrderCutIssueRulesModule],
  controllers: [MasterActionsController],
  providers: [MasterActionsService],
  exports: [MasterActionsService],
})
export class MasterActionsModule {}
