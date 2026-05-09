import { Module } from '@nestjs/common';
import { PackingService } from './packing.service.js';
import { PackingController } from './packing.controller.js';
import { BoxNumberService } from './box-number.service.js';
import { EarningsModule } from '../earnings/earnings.module.js';
import { FinishedGoodsModule } from '../finished-goods/finished-goods.module.js';
import { WorkInProgressModule } from '../work-in-progress/work-in-progress.module.js';

/**
 * Модуль упаковки и выпуска изделия (Шаг 8 MVP).
 * Контракты: `docs/api.md §9`. Бизнес-правила: `docs/flows.md §F7`.
 *
 * Импортирует `EarningsModule`, чтобы в той же транзакции, что и
 * `Passport.status → PACKED`, переводить все pending-начисления по
 * паспорту в `APPROVED` (Шаг 9, ADR-0005).
 *
 * Импортирует `FinishedGoodsModule`, чтобы в той же транзакции, что
 * и `Passport.status → PACKED`, фиксировать выпуск готовой продукции
 * (`FinishedGoodsMovement` `type = PRODUCTION_RECEIPT`,
 * `direction = IN`, idempotent по
 * `sourceKey = PACKED_PASSPORT:<passportId>`). См.
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts`,
 * `docs/current-state.md §«Готовая продукция»`.
 */
@Module({
  imports: [EarningsModule, FinishedGoodsModule, WorkInProgressModule],
  controllers: [PackingController],
  providers: [PackingService, BoxNumberService],
  exports: [PackingService],
})
export class PackingModule {}
