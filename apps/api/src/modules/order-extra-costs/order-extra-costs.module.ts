import { Module } from '@nestjs/common';

import { OrderCostEstimatesModule } from '../orders/order-cost-estimates.module.js';
import { OrderExtraCostsController } from './order-extra-costs.controller.js';
import { OrderExtraCostsService } from './order-extra-costs.service.js';

/**
 * Модуль «Прочие / непредвиденные расходы заказа» (этап «Корректировка
 * материалов после просчёта»).
 *
 * См. `OrderExtraCostsService` JSDoc. `AuditService` / `PrismaService`
 * инжектятся через глобальные модули (`AuditModule` / `PrismaModule`),
 * отдельные `imports` не требуются. Сервис экспортируется, чтобы
 * `OrderCostEstimatesService` мог читать активные расходы при
 * завершении / пересчёте себестоимости (на MVP он читает их напрямую
 * через `PrismaService`, экспорт — на будущее).
 */
@Module({
  // Фича «Правка потребности на любой стадии»: после CRUD расхода сервис
  // зовёт автопересчёт сметы (`syncAfterNeedsChange`). Модуль сметы без
  // `imports`, цикла не образуется.
  imports: [OrderCostEstimatesModule],
  controllers: [OrderExtraCostsController],
  providers: [OrderExtraCostsService],
  exports: [OrderExtraCostsService],
})
export class OrderExtraCostsModule {}
