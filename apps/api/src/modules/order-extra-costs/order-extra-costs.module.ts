import { Module } from '@nestjs/common';

import { OrderCostEstimatesModule } from '../orders/order-cost-estimates.module.js';
import { ProductionDocumentsModule } from '../production-documents/production-documents.module.js';
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
  // `ProductionDocumentsModule` — аудит движка расчёта 13.09.2026, D1-3 (ревью): CRUD расхода
  // «в себестоимость» будит документ выпуска закрытого заказа. Модуль документов зависит
  // только от `CostsModule`, цикла не образуется.
  imports: [OrderCostEstimatesModule, ProductionDocumentsModule],
  controllers: [OrderExtraCostsController],
  providers: [OrderExtraCostsService],
  exports: [OrderExtraCostsService],
})
export class OrderExtraCostsModule {}
