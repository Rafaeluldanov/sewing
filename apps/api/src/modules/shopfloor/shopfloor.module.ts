import { Module } from '@nestjs/common';
import { ShopfloorController } from './shopfloor.controller.js';
import { ShopfloorService } from './shopfloor.service.js';

@Module({
  controllers: [ShopfloorController],
  providers: [ShopfloorService],
  exports: [ShopfloorService],
})
export class ShopfloorModule {}
