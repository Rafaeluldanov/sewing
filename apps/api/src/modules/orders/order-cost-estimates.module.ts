import { Module } from '@nestjs/common';

import { OrderCostEstimatesService } from './order-cost-estimates.service.js';

/**
 * Модуль «Себестоимость заказа» (`OrderCostEstimate`).
 *
 * Сервис жил провайдером внутри `OrdersModule`, но с фичей «Правка
 * потребности на любой стадии» его зовёт ещё и `WorkshopNeedsService`
 * (автопересчёт сметы после правки строки). Прямой инжект оттуда дал бы
 * цикл модулей: `OrdersModule` уже импортирует `WorkshopNeedsModule`
 * ради `calculateForOrder`.
 *
 * Поэтому сервис вынесен в собственный модуль БЕЗ `imports` — он
 * работает только с `PrismaService` и `AuditService` (глобальные
 * модули). Его импортируют и `OrdersModule`, и `WorkshopNeedsModule`;
 * цикла нет, `forwardRef` не нужен.
 */
@Module({
  providers: [OrderCostEstimatesService],
  exports: [OrderCostEstimatesService],
})
export class OrderCostEstimatesModule {}
