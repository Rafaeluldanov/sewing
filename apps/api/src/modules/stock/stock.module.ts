import { Module } from '@nestjs/common';

import { CompanySettingsModule } from '../company-settings/company-settings.module.js';
import { StockController } from './stock.controller.js';
import { StockService } from './stock.service.js';

/**
 * Foundation складского учёта материалов (`StockBalance` /
 * `StockMovement`).
 *
 * Сервис экспортируется наружу — `PurchaseReceiptsModule` и
 * `MaterialIssuesModule` импортируют его, чтобы писать движения в
 * той же транзакции, что и бизнес-документ.
 *
 * Контроллер `StockController` подключает API
 * (`GET /api/stock/balances`, `GET /api/stock/movements`,
 * `POST /api/stock/adjustments` — ручная корректировка остатка,
 * см. `docs/api.md §«Stock»`).
 *
 * Импорт `CompanySettingsModule` нужен `StockService.createAdjustment`,
 * чтобы прочитать `CompanySettings.allowNegativeMaterialStock` перед
 * OUT-корректировкой (для `IN` флаг не влияет). `AuditService`
 * берётся из глобального `AuditModule` — отдельный import не нужен.
 */
@Module({
  imports: [CompanySettingsModule],
  controllers: [StockController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
