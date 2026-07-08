import { Module } from '@nestjs/common';
import { OrderColorwaysController } from './order-colorways.controller.js';
import { OrderColorwaysService } from './order-colorways.service.js';
import { OrdersModule } from '../orders/orders.module.js';

/**
 * Фича «Расцветки заказа» (colorways, флаг `FEATURE_COLORWAYS`).
 *
 * `PrismaService` инжектится через глобальный `PrismaModule`
 * (`@Global()`). `OrdersModule` импортируем ради
 * `OrdersService.resyncColorwayDerived` — после правки расцветки надо
 * пересобрать снимок материалов и потребности цеха. Цикла нет:
 * `OrdersModule` про расцветки ничего не знает (одностороннее ребро).
 */
@Module({
  imports: [OrdersModule],
  controllers: [OrderColorwaysController],
  providers: [OrderColorwaysService],
  exports: [OrderColorwaysService],
})
export class OrderColorwaysModule {}
