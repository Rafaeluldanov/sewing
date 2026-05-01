import { Module } from '@nestjs/common';
import { CuttingClosureController } from './cutting-closure.controller.js';
import { PassportCuttingClosureController } from './passport-cutting-closure.controller.js';
import { CuttingClosureService } from './cutting-closure.service.js';

/**
 * Модуль «Закрытие раскроя по размеру через заявку» (ADR-0018).
 *
 * Источник истины — backend: `CuttingClosureService` решает, можно ли
 * выпускать новые паспорта по строке. `PassportsService` зависит от
 * этого сервиса напрямую (см. `PassportsModule`), поэтому здесь
 * экспортируем сервис.
 */
@Module({
  controllers: [CuttingClosureController, PassportCuttingClosureController],
  providers: [CuttingClosureService],
  exports: [CuttingClosureService],
})
export class CuttingClosureModule {}
