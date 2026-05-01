import { Module } from '@nestjs/common';
import { PackingService } from './packing.service.js';
import { PackingController } from './packing.controller.js';
import { BoxNumberService } from './box-number.service.js';
import { EarningsModule } from '../earnings/earnings.module.js';

/**
 * Модуль упаковки и выпуска изделия (Шаг 8 MVP).
 * Контракты: `docs/api.md §9`. Бизнес-правила: `docs/flows.md §F7`.
 *
 * Импортирует `EarningsModule`, чтобы в той же транзакции, что и
 * `Passport.status → PACKED`, переводить все pending-начисления по
 * паспорту в `APPROVED` (Шаг 9, ADR-0005).
 */
@Module({
  imports: [EarningsModule],
  controllers: [PackingController],
  providers: [PackingService, BoxNumberService],
  exports: [PackingService],
})
export class PackingModule {}
