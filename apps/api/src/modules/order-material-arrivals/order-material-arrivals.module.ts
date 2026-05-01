import { Module } from '@nestjs/common';

import { OrderMaterialArrivalsController } from './order-material-arrivals.controller.js';
import { OrderMaterialArrivalsService } from './order-material-arrivals.service.js';

/**
 * Модуль «Ручная отметка поступления материала» (см.
 * `apps/api/src/modules/order-material-arrivals/*`,
 * `prisma/schema.prisma::OrderMaterialArrivalOverride`,
 * `apps/api/src/modules/cut-readiness/cut-readiness.service.ts`).
 *
 * Дизайн (см. `OrderMaterialArrivalsService` JSDoc):
 *   - один контроллер на `/api/orders/:orderId/...` с собственной
 *     RBAC-границей (ADMIN/SHOP_MANAGER на запись,
 *     CUTTER/CUTTER_ASSISTANT на чтение). Не подвешиваем к
 *     `OrdersController`, чтобы не расширять матрицу ролей и не
 *     тащить зависимость от `CutReadinessService` в `OrdersService`.
 *   - сервис экспортируется наружу — на будущее `CutReadinessService`
 *     может его инжектить, но на MVP `CutReadinessService` читает
 *     overrides напрямую через `PrismaService`, чтобы не плодить
 *     перекрёстные зависимости модулей.
 *   - `AuditService` / `PrismaService` инжектятся через глобальные
 *     модули (`AuditModule` / `PrismaModule` помечены `@Global()`),
 *     отдельные `imports` не требуются.
 */
@Module({
  controllers: [OrderMaterialArrivalsController],
  providers: [OrderMaterialArrivalsService],
  exports: [OrderMaterialArrivalsService],
})
export class OrderMaterialArrivalsModule {}
