import { Module } from '@nestjs/common';

import { WorkInProgressController } from './work-in-progress.controller.js';
import { WorkInProgressService } from './work-in-progress.service.js';

/**
 * Foundation полуфабриката (см.
 * `apps/api/src/modules/work-in-progress/work-in-progress.service.ts`,
 * `prisma/schema.prisma::WorkInProgressBalance` /
 * `WorkInProgressMovement`).
 *
 * Сервис экспортируется наружу — `PassportsModule`, `MasterActionsModule`
 * и `PackingModule` импортируют его, чтобы в той же транзакции, что
 * и обновление паспорта/CellContent, писать `WorkInProgressMovement`.
 */
@Module({
  controllers: [WorkInProgressController],
  providers: [WorkInProgressService],
  exports: [WorkInProgressService],
})
export class WorkInProgressModule {}
