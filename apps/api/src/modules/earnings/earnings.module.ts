import { Module } from '@nestjs/common';
import { EarningsService } from './earnings.service.js';
import { EarningsController } from './earnings.controller.js';
import { PassportEarningsController } from './passport-earnings.controller.js';
import { OperationsModule } from '../operations/operations.module.js';

/**
 * Модуль сдельных начислений (Шаг 9 MVP).
 *
 * Контракты — `docs/api.md §10`. Бизнес-правила — ADR-0005, ADR-0012,
 * `docs/flows.md §F2 / §F4 / §F7`. Экспортирует `EarningsService`,
 * чтобы `PassportsModule` (создание и сканирование) и `PackingModule`
 * (апрув при упаковке) могли вызывать его в своих транзакциях.
 *
 * Зависит от `OperationsModule`, потому что источник истины ставок —
 * `OperationsService.resolveRate(...)` (см. `docs/domain.md §16a`,
 * `docs/api.md §15a`). Историческая таблица `PieceRate` для подсчёта
 * новых начислений больше не используется.
 */
@Module({
  imports: [OperationsModule],
  controllers: [EarningsController, PassportEarningsController],
  providers: [EarningsService],
  exports: [EarningsService],
})
export class EarningsModule {}
