import { Module } from '@nestjs/common';

import { FinishedGoodsController } from './finished-goods.controller.js';
import { FinishedGoodsService } from './finished-goods.service.js';

/**
 * Foundation готовой продукции (см.
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts`,
 * `prisma/schema.prisma::FinishedGoodsBalance` / `FinishedGoodsMovement`,
 * `docs/current-state.md §«Готовая продукция»`).
 *
 * Сервис экспортируется наружу — `PackingModule` импортирует его,
 * чтобы в той же транзакции, что и `Passport.status = PACKED`, писать
 * `FinishedGoodsMovement` `type = PRODUCTION_RECEIPT`,
 * `direction = IN`.
 *
 * Контроллер `FinishedGoodsController` подключает read-only API
 * (`GET /api/finished-goods/balances`, `GET /api/finished-goods/movements`).
 *
 * `AuditService` берётся из глобального `AuditModule` — отдельный
 * import не нужен.
 */
@Module({
  controllers: [FinishedGoodsController],
  providers: [FinishedGoodsService],
  exports: [FinishedGoodsService],
})
export class FinishedGoodsModule {}
