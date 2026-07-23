import { Module } from '@nestjs/common';
import { EarningsModule } from '../earnings/earnings.module.js';
import { PushModule } from '../push/push.module.js';
import {
  MasterQtyCorrectionsController,
  QcQtyCorrectionsController,
} from './passport-qty-corrections.controller.js';
import { PassportQtyCorrectionsService } from './passport-qty-corrections.service.js';

/**
 * Модуль «Корректировка фактического количества по паспорту»
 * (ОТК → мастер цеха, Фаза 1). Двухшаговая заявка на уровне паспорта.
 *
 * Зависит от `EarningsModule` (пересчёт сдельной ЗП швей + раскройщика
 * по новым `qtyGood`/`qtyCut`) и `PushModule` (уведомление мастерам о
 * новой заявке). `AuditService` — глобальный. Экспортирует сервис,
 * чтобы `QcModule` мог показать открытую заявку на карточке ОТК.
 */
@Module({
  imports: [EarningsModule, PushModule],
  controllers: [QcQtyCorrectionsController, MasterQtyCorrectionsController],
  providers: [PassportQtyCorrectionsService],
  exports: [PassportQtyCorrectionsService],
})
export class PassportQtyCorrectionsModule {}
