import { Module } from '@nestjs/common';

import { CutReadinessController } from './cut-readiness.controller.js';
import { CutReadinessService } from './cut-readiness.service.js';

/**
 * Модуль «Готовность к крою» (Этап 8А, см.
 * `docs/recon-soft-integration.md §«Этап 8А»`).
 *
 * Read-only / computed: НЕТ Prisma-моделей, НЕТ миграций, НЕТ
 * новых статусов заказа. Сервис собирает срез по заказу
 * (лекало / техкарта / `WorkshopNeed` / `PurchaseReceiptLine`) и
 * возвращает агрегированный `CutReadinessDto`. Никаких записей в БД
 * сервис не делает.
 *
 * Один контроллер `/api/orders/:orderId/cut-readiness`. Вынесен в
 * отдельный модуль (а не в `OrdersController`), чтобы:
 *   - `OrdersController` не таскал зависимости приёмки/потребности;
 *   - RBAC расширялся для кройщиков (`CUTTER`/`CUTTER_ASSISTANT`)
 *     без расширения матрицы ролей основного `OrdersController`.
 */
@Module({
  controllers: [CutReadinessController],
  providers: [CutReadinessService],
  exports: [CutReadinessService],
})
export class CutReadinessModule {}
