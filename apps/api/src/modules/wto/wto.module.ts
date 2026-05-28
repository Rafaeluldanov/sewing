import { Module } from '@nestjs/common';
import { WtoService } from './wto.service.js';
import { WtoController } from './wto.controller.js';
import { EarningsModule } from '../earnings/earnings.module.js';

/**
 * Модуль ВТО (role-terminal `/wto`).
 * Контракты: `docs/api.md §12` (раздел WTO). Бизнес-правила:
 * `docs/flows.md §F6`, ADR-0013 §«WTO_DONE bucket».
 */
@Module({
  imports: [EarningsModule],
  controllers: [WtoController],
  providers: [WtoService],
  exports: [WtoService],
})
export class WtoModule {}
