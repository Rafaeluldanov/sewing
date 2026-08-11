import { Module } from '@nestjs/common';
import { MeModule } from '../me/me.module.js';
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
  // `MeModule` — ради `MeService.verifyEmployeeQrToken`: закрытие
  // вызова сканом принимает «Мой QR-код» сотрудника, подписанный
  // `JWT_SECRET` (секрет читается там же, где подписывается).
  imports: [MeModule],
  controllers: [MasterCallsController],
  providers: [MasterCallsService],
  exports: [MasterCallsService],
})
export class MasterCallsModule {}
