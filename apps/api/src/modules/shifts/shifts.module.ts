import { Module } from '@nestjs/common';
import { ShiftsController } from './shifts.controller.js';
import { ShiftsService } from './shifts.service.js';
import { ShiftAutoCloseService } from './shift-auto-close.service.js';
import { SalaryModule } from '../salary/salary.module.js';

/**
 * `ShiftAutoCloseService` экспортируется наружу: проверку «не пора ли
 * закрыть забытые смены» дёргают экраны, которым эти данные и нужны —
 * табель мастера и тайм-трекер админки (планировщика в проекте нет,
 * см. JSDoc сервиса).
 *
 * `RecutModule` здесь сознательно НЕТ: закрытие смены подкрой не
 * завершает — «жёсткая граница сменой или предупреждение мастеру» — это
 * решение №12 Аудита движка расчёта 13.09.2026, владельцем не принято
 * (ревью G4-3); у подкроя свой предохранитель и флаги предупреждения
 * (`RecutService`).
 */
@Module({
  imports: [SalaryModule],
  controllers: [ShiftsController],
  providers: [ShiftsService, ShiftAutoCloseService],
  exports: [ShiftsService, ShiftAutoCloseService],
})
export class ShiftsModule {}
