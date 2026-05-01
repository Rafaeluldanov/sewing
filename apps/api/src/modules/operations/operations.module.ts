import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OperationsController } from './operations.controller.js';
import { OperationsService } from './operations.service.js';

/**
 * Управляющий модуль «Операции» (см. `docs/domain.md §16a`,
 * `docs/api.md §15a`).
 *
 * `OperationsService` экспортируется, чтобы `EarningsModule` мог
 * вызывать `resolveRate(operationId, sizeId)` — единый источник
 * истины сдельных ставок (см. ADR-0005, `docs/domain.md §9.2`).
 */
@Module({
  imports: [PrismaModule],
  controllers: [OperationsController],
  providers: [OperationsService],
  exports: [OperationsService],
})
export class OperationsModule {}
