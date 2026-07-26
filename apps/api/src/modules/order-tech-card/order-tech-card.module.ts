import { Module } from '@nestjs/common';

import { OrdersModule } from '../orders/orders.module.js';
import { TechCardsModule } from '../tech-cards/tech-cards.module.js';
import {
  OrderTechCardController,
  OrderTechCardLinesController,
} from './order-tech-card.controller.js';
import { OrderTechCardTemplateController } from './order-tech-card-template.controller.js';
import { OrderTechCardService } from './order-tech-card.service.js';

/**
 * Фича «Параметры техкарт»: значения слотов по расцветкам заказа + ad-hoc слоты.
 *
 * Устроен как `OrderColorwaysModule`: `OrdersModule` импортируется ради
 * `OrdersService.resyncTechCardDerived` — после правки надо пересобрать
 * снимок материалов и потребности цеха ТЕМ ЖЕ единственным путём (он же
 * решает, идти обычным ресинком или amendment-путём, если заказ уже прошёл
 * расчёт). Цикла нет: `OrdersModule` про этот модуль ничего не знает.
 */
@Module({
  // TechCardsModule — ради `createFromOrderSnapshot` («сохранить как шаблон»):
  // знание о том, КАК писать шаблон, остаётся в модуле техкарт.
  imports: [OrdersModule, TechCardsModule],
  controllers: [
    OrderTechCardController,
    OrderTechCardLinesController,
    OrderTechCardTemplateController,
  ],
  providers: [OrderTechCardService],
  exports: [OrderTechCardService],
})
export class OrderTechCardModule {}
