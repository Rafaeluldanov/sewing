import { Module } from '@nestjs/common';

import { CompanySettingsModule } from '../company-settings/company-settings.module.js';
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
 * Также импортирует `CompanySettingsModule` ради
 * `CompanySettingsService.getAllowNegativeMaterialStock()`:
 * `MaterialIssuesService` читает hardening-флаг ПЕРЕД
 * `recordMaterialIssueInTx` и пробрасывает его в `StockService`,
 * чтобы при `false` 409 `MATERIAL_STOCK_INSUFFICIENT` откатывал и
 * сам `MaterialIssue` (см.
 * `prisma/schema.prisma::CompanySettings.allowNegativeMaterialStock`,
 * `docs/current-state.md §«Material issue → StockMovement OUT»`).
 *
 * Сознательная граница MVP (см. `docs/current-state.md §«Material
 * issue → StockMovement OUT»`):
 *   - НЕТ FIFO/LIFO;
 *   - НЕТ `MaterialStockLot`;
 *   - проверка достаточности остатков опциональна и управляется
 *     `CompanySettings.allowNegativeMaterialStock` (по умолчанию
 *     `true` — минус допустим, MVP-поведение сохраняется);
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
  imports: [StockModule, CompanySettingsModule],
  controllers: [MaterialIssuesController, MaterialIssuesOrderController],
  providers: [MaterialIssuesService],
  exports: [MaterialIssuesService],
})
export class MaterialIssuesModule {}
