import { Module } from '@nestjs/common';
import { OrderCutIssueRulesController } from './order-cut-issue-rules.controller.js';
import { OrderCutIssueRulesService } from './order-cut-issue-rules.service.js';

/**
 * «Очередь выдачи кроя по размерам» (см.
 * `apps/api/src/modules/order-cut-issue-rules/*`,
 * `prisma/schema.prisma::OrderCutIssueRule`,
 * `docs/domain.md §«Очередь выдачи кроя»`).
 *
 * Сервис экспортируется наружу, потому что
 * `PassportsService.issueToEmployee` инжектит его и вызывает
 * `evaluateForIssue` / `consumeInTx` в той же транзакции, что и
 * списание `CutReleasePolicy` / обновление паспорта (порядок:
 * `OrderCutIssueRule → CutReleasePolicy`).
 *
 * `AuditService` / `PrismaService` инжектятся через глобальные модули
 * (`AuditModule` / `PrismaModule` помечены `@Global()`), отдельные
 * `imports` не требуются.
 */
@Module({
  controllers: [OrderCutIssueRulesController],
  providers: [OrderCutIssueRulesService],
  exports: [OrderCutIssueRulesService],
})
export class OrderCutIssueRulesModule {}
