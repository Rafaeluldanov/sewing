import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderNumberService } from './order-number.service';
import { RoutesModule } from '../routes/routes.module.js';
import { TechCardsModule } from '../tech-cards/tech-cards.module.js';

@Module({
  imports: [RoutesModule, TechCardsModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderNumberService],
  exports: [OrdersService],
})
export class OrdersModule {}
