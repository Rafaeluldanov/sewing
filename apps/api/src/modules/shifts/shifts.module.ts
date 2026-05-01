import { Module } from '@nestjs/common';
import { ShiftsController } from './shifts.controller.js';
import { ShiftsService } from './shifts.service.js';
import { SalaryModule } from '../salary/salary.module.js';

@Module({
  imports: [SalaryModule],
  controllers: [ShiftsController],
  providers: [ShiftsService],
  exports: [ShiftsService],
})
export class ShiftsModule {}
