import { Module } from '@nestjs/common';

import { OrdersModule } from '../orders/orders.module.js';
import { OrderTechCardController } from './order-tech-card.controller.js';
import { OrderTechCardService } from './order-tech-card.service.js';

/**
 * Фича «Параметры техкарт»: значения слотов по расцветкам заказа + ad-hoc слоты.
 *
 * Устроен как `OrderColorwaysModule`: `OrdersModule` импортируется ради
 * `OrdersService.resyncColorwayDerived` — после правки значения надо пересобрать
 * снимок материалов и потребности цеха ТЕМ ЖЕ единственным путём. Цикла нет:
 * `OrdersModule` про этот модуль ничего не знает.
 */
@Module({
  imports: [OrdersModule],
  controllers: [OrderTechCardController],
  providers: [OrderTechCardService],
  exports: [OrderTechCardService],
})
export class OrderTechCardModule {}
