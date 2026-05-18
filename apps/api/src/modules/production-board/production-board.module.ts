import { Module } from '@nestjs/common';
import { ProductionBoardController } from './production-board.controller.js';
import { ProductionBoardService } from './production-board.service.js';

/**
 * «Доска движения тиража» для кабинета мастера (read-only).
 *
 * См. `apps/api/src/modules/production-board/production-board.controller.ts`,
 * `packages/shared/src/production-board.ts`, вкладку «Движение тиража»
 * в `apps/web/app/master`.
 *
 * `PrismaService` инжектится через глобальный `PrismaModule` — отдельные
 * `imports` не требуются.
 */
@Module({
  controllers: [ProductionBoardController],
  providers: [ProductionBoardService],
  exports: [ProductionBoardService],
})
export class ProductionBoardModule {}
