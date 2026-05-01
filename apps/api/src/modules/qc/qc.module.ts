import { Module } from '@nestjs/common';
import { QcService } from './qc.service.js';
import { QcController } from './qc.controller.js';
import { DefectTypesController } from './defect-types.controller.js';
import { PassportDefectsController } from './passport-defects.controller.js';

/**
 * Модуль ОТК и фиксации брака (Шаг 7 MVP).
 * Контракты: `docs/api.md §8`. Бизнес-правила: `docs/flows.md §F5`.
 */
@Module({
  controllers: [
    QcController,
    DefectTypesController,
    PassportDefectsController,
  ],
  providers: [QcService],
  exports: [QcService],
})
export class QcModule {}
