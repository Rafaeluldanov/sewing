import { Module } from '@nestjs/common';
import { MasterCallsController } from './master-calls.controller.js';
import { MasterCallsService } from './master-calls.service.js';

/**
 * Модуль «Мастер цеха» (MVP).
 *
 * См. `docs/domain.md §«Мастер цеха»`, `docs/flows.md §«Вызов мастера»`,
 * `prisma/schema.prisma::MasterCall`.
 *
 * `AuditService` инжектится напрямую — `AuditModule` помечен как
 * `@Global()` (см. `apps/api/src/modules/audit/audit.module.ts`),
 * поэтому отдельный `imports` не нужен. То же касается `PrismaService`
 * — он раздаётся `@Global()` `PrismaModule`.
 */
@Module({
  controllers: [MasterCallsController],
  providers: [MasterCallsService],
  exports: [MasterCallsService],
})
export class MasterCallsModule {}
