import { Module } from '@nestjs/common';
import { OrderCostEstimatesModule } from './order-cost-estimates.module.js';
import { OrderOperationPlanService } from './order-operation-plan.service.js';
import { OrderProductionBalanceService } from './order-production-balance.service.js';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderNumberService } from './order-number.service';
import { RoutesModule } from '../routes/routes.module.js';
import { WorkshopNeedsModule } from '../workshop-needs/workshop-needs.module.js';

@Module({
  // Soft-pattern MVP (этап 2 «Лекала»): валидация выбранного лекала и
  // чтение полей для snapshot при `start()` идут через PrismaService
  // напрямую (см. `OrdersService.assertPatternUsable`). Это та же
  // схема, что используется для `clientId` (см. `assertClientUsable`),
  // и не требует `PatternsModule` в `imports` — soft-coupling, без
  // циркулярных зависимостей с модулем «Лекала».
  //
  // Этап «Расчёт»: `OrdersService.startCalculation` делегирует
  // расчёт потребностей в `WorkshopNeedsService.calculateForOrder`.
  // Импортируем `WorkshopNeedsModule`, чтобы получить готовый
  // экспорт сервиса. Обратной зависимости нет — `WorkshopNeedsModule`
  // работает только с PrismaService/AuditService и не дёргает
  // `OrdersService`, поэтому циркула не образуется.
  //
  // Этап «Себестоимость заказа»: `OrderCostEstimatesService` вынесен в
  // собственный `OrderCostEstimatesModule` — его теперь зовёт ещё и
  // `WorkshopNeedsService` (автопересчёт сметы после правки строки
  // потребности), а прямой провайдер здесь дал бы цикл модулей
  // (`OrdersModule` → `WorkshopNeedsModule` → `OrdersModule`).
  // Модуль без `imports`, поэтому цикла не образуется.
  imports: [
    RoutesModule,
        WorkshopNeedsModule,
    OrderCostEstimatesModule,
  ],
  controllers: [OrdersController],
  // Этап 2 «План операций на заказе»: `OrderOperationPlanService` живёт
  // в этом же модуле — он работает только с PrismaService и читает
  // `Operation` / `RouteTemplate` (через `tx`), никаких внешних модулей
  // не требует. `OrdersService` инжектит его и вызывает
  // `recalculateAndWrite` на `create` / `update` (DRAFT) /
  // `startCalculation`. См. `docs/operation-time-norms-recon.md §11`.
  //
  // Балансировка цепочки (`OrderProductionBalanceService`) — тоже
  // живёт в этом же модуле; это computed-helper, который читает
  // только `Order` / `OrderItem` / `RouteTemplate.steps` / `Operation`
  // через PrismaService и не пишет в БД (см. JSDoc сервиса). Никаких
  // внешних модулей не требует, payroll/Passport/OperationEntry/
  // SalaryEntry/WorkshopNeed/OrderCostEstimate не трогает.
  providers: [
    OrdersService,
    OrderNumberService,
    OrderOperationPlanService,
    OrderProductionBalanceService,
  ],
  exports: [OrdersService, OrderCostEstimatesModule, OrderNumberService],
})
export class OrdersModule {}
