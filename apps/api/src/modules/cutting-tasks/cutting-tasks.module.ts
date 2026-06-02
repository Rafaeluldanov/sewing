import { Module } from '@nestjs/common';
import { CuttingTasksController } from './cutting-tasks.controller.js';
import { CuttingTasksService } from './cutting-tasks.service.js';

/**
 * «Кабинет раскройщика» (роль `CUTTER`). См.:
 *   - `prisma/schema.prisma::CuttingTask` / `CuttingTaskSizeRow` /
 *     `CuttingTaskRoll`;
 *   - `apps/web/app/cutter/*` — кабинет раскройщика;
 *   - `packages/shared/src/cutting-tasks.ts` — контракты.
 *
 * Сами задачи создаёт `OrdersService.start()` при переходе заказа в
 * `IN_PRODUCTION` (inline в той же транзакции, без зависимости на этот
 * модуль — чтобы не плодить circular import с `OrdersModule`).
 */
@Module({
  controllers: [CuttingTasksController],
  providers: [CuttingTasksService],
  exports: [CuttingTasksService],
})
export class CuttingTasksModule {}
