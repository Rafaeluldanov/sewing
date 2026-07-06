import { Module } from '@nestjs/common';
import { OrderColorwaysController } from './order-colorways.controller.js';
import { OrderColorwaysService } from './order-colorways.service.js';

/**
 * Фича «Расцветки заказа» (colorways, флаг `FEATURE_COLORWAYS`).
 *
 * `PrismaService` инжектится через глобальный `PrismaModule`
 * (`@Global()`), отдельные `imports` не нужны. Модуль самодостаточный:
 * ничего из существующих сервисов не переопределяет — аддитивно.
 */
@Module({
  controllers: [OrderColorwaysController],
  providers: [OrderColorwaysService],
  exports: [OrderColorwaysService],
})
export class OrderColorwaysModule {}
