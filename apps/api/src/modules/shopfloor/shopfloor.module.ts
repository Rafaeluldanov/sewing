import { Module } from '@nestjs/common';
import { CutReadinessModule } from '../cut-readiness/cut-readiness.module.js';
import { OrderStandController } from './order-stand.controller.js';
import { OrderStandService } from './order-stand.service.js';
import { ShopfloorController } from './shopfloor.controller.js';
import { ShopfloorService } from './shopfloor.service.js';

@Module({
  // «Схема стенда» по заказу показывает готовность к крою в блоке «Материал»
  // — берём готовый `CutReadinessService`, а не дублируем проверку.
  imports: [CutReadinessModule],
  controllers: [ShopfloorController, OrderStandController],
  providers: [ShopfloorService, OrderStandService],
  exports: [ShopfloorService],
})
export class ShopfloorModule {}
