import { Module } from '@nestjs/common';
import { CutReleasePolicyController } from './cut-release-policy.controller.js';
import { CutReleasePolicyService } from './cut-release-policy.service.js';

/**
 * Stage 3 «Мастер цеха» — управление одной активной политикой выдачи
 * кроя. Сервис экспортируется наружу, чтобы `PassportsModule` мог
 * инжектить его в `PassportsService.issueToEmployee` (а не дублировать
 * логику lookup'а активной политики и сборки exception-сообщения).
 *
 * `AuditService` / `PrismaService` инжектятся через глобальные модули
 * (`AuditModule` / `PrismaModule` помечены `@Global()`), отдельные
 * `imports` не требуются.
 */
@Module({
  controllers: [CutReleasePolicyController],
  providers: [CutReleasePolicyService],
  exports: [CutReleasePolicyService],
})
export class CutReleasePolicyModule {}
