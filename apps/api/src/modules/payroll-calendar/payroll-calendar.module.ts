import { Module } from '@nestjs/common';
import { PayrollCalendarController } from './payroll-calendar.controller.js';
import { PayrollCalendarService } from './payroll-calendar.service.js';

/**
 * Модуль производственного календаря (`PayrollCalendarMonth`,
 * 29.07.2026): норма рабочих дней и часов на месяц.
 *
 * Контракт — `docs/api.md §31a`. Правила — `docs/domain.md §9a`
 * («Месячный оклад»). UI — `/admin/payroll/calendar`.
 *
 * Читающая сторона живёт не здесь, а в
 * `apps/api/src/modules/salary/salary-rate.ts`: норма нужна как
 * знаменатель производной ставки ₽/час у месячного окладника, и
 * тянуть ради одного `findUnique` зависимость на сервис было бы
 * лишним связыванием.
 */
@Module({
  controllers: [PayrollCalendarController],
  providers: [PayrollCalendarService],
  exports: [PayrollCalendarService],
})
export class PayrollCalendarModule {}
