import { Module } from '@nestjs/common';
import { RecutController } from './recut.controller.js';
import { RecutService } from './recut.service.js';
import { SalaryModule } from '../salary/salary.module.js';

/**
 * Фича «Подкрой» (`RecutSession`, роль `CUTTER`). См.:
 *   - `prisma/schema.prisma::RecutSession` + `SalaryEntrySource.RECUT`;
 *   - `apps/web/app/cutter/recut-panel.tsx` (+ `lib/recut-api.ts`);
 *   - `packages/shared/src/recut.ts` — контракты.
 *
 * Импортирует `SalaryModule`, чтобы при завершении/отмене подкроя
 * пересчитать дневную строку `SalaryEntry(source = RECUT)`
 * (`SalaryService.syncDailyRecut`) — почасовая доплата сверх смены.
 */
@Module({
  imports: [SalaryModule],
  controllers: [RecutController],
  providers: [RecutService],
  exports: [RecutService],
})
export class RecutModule {}
