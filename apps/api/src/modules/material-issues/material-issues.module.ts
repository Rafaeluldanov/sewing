import { Module } from '@nestjs/common';

import { StockModule } from '../stock/stock.module.js';
import { MaterialIssuesController } from './material-issues.controller.js';
import { MaterialIssuesOrderController } from './material-issues.order-controller.js';
import { MaterialIssuesService } from './material-issues.service.js';

/**
 * Material issues — фактический расход материалов по заказу
 * (`apps/api/src/modules/material-issues/material-issues.service.ts`,
 * `prisma/schema.prisma::MaterialIssue` / `MaterialIssueLine`,
 * `docs/api.md §«Material issues»`).
 *
 * Модуль импортирует `StockModule`, чтобы `MaterialIssuesService`
 * мог проинжектить `StockService` и записать исходящее движение
 * (`StockMovement` OUT) в той же транзакции, что и переход
 * `DRAFT → POSTED` ручного документа или создание авто-документа
 * при выдаче кроя. Обратного импорта (Stock → MaterialIssues) нет —
 * `StockModule` изолирован.
 *
 * Сознательная граница MVP (см. `docs/current-state.md §«Material
 * issue → StockMovement OUT»`):
 *   - НЕТ FIFO/LIFO;
 *   - НЕТ `MaterialStockLot`;
 *   - НЕТ проверок достаточности остатков (post не блокируется
 *     минусом);
 *   - POSTED-документ нельзя отменить (сторнирующий reversal для
 *     `MaterialIssue` — отдельная будущая итерация).
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
  imports: [StockModule],
  controllers: [MaterialIssuesController, MaterialIssuesOrderController],
  providers: [MaterialIssuesService],
  exports: [MaterialIssuesService],
})
export class MaterialIssuesModule {}
