import { Module } from '@nestjs/common';
import { QcService } from './qc.service.js';
import { QcController } from './qc.controller.js';
import { DefectTypesController } from './defect-types.controller.js';
import { PassportDefectsController } from './passport-defects.controller.js';
import { EarningsModule } from '../earnings/earnings.module.js';
import { PushModule } from '../push/push.module.js';

/**
 * Модуль ОТК и фиксации брака (Шаг 7 MVP).
 * Контракты: `docs/api.md §8`. Бизнес-правила: `docs/flows.md §F5`.
 *
 * Зависит от `EarningsModule` ради `revokePendingForOperation` —
 * `returnToRework` отзывает pending у швеи предыдущего прохода
 * (см. `docs/flows.md §F5a`, инвариант «оплата за изделие — один раз»).
 */
@Module({
  imports: [EarningsModule, PushModule],
  controllers: [
    QcController,
    DefectTypesController,
    PassportDefectsController,
  ],
  providers: [QcService],
  exports: [QcService],
})
export class QcModule {}
