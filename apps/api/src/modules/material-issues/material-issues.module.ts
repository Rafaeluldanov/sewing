import { Module } from '@nestjs/common';

import { MaterialIssuesController } from './material-issues.controller.js';
import { MaterialIssuesOrderController } from './material-issues.order-controller.js';
import { MaterialIssuesService } from './material-issues.service.js';

/**
 * Material issues MVP — фактический расход материалов по заказу
 * (см. `apps/api/src/modules/material-issues/material-issues.service.ts`,
 * `prisma/schema.prisma::MaterialIssue` / `MaterialIssueLine`,
 * `docs/api.md §«Material issues»`).
 *
 * Сознательная граница MVP:
 *   - НЕТ `StockBalance` / `MaterialStockLot` / `StockMovement`;
 *   - НЕТ FIFO/LIFO;
 *   - НЕТ автосписания при выдаче кроя;
 *   - POSTED-документ нельзя отменить.
 *
 * Два контроллера:
 *   - `MaterialIssuesController` — `/api/material-issues/*`
 *     (CRUD-light + actions);
 *   - `MaterialIssuesOrderController` —
 *     `/api/orders/:orderId/material-issues` (список по заказу).
 *     Вынесен в отдельный контроллер, чтобы не пересекаться с
 *     RBAC `OrdersController`.
 *
 * `AuditService` инжектится через глобальный `AuditModule` —
 * дополнительного `imports` не требуется.
 */
@Module({
  controllers: [MaterialIssuesController, MaterialIssuesOrderController],
  providers: [MaterialIssuesService],
  exports: [MaterialIssuesService],
})
export class MaterialIssuesModule {}
