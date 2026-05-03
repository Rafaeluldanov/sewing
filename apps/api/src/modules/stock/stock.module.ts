import { Module } from '@nestjs/common';

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
 * Контроллер `StockController` подключает read-only API
 * (`GET /api/stock/balances`, `GET /api/stock/movements`,
 * см. `docs/api.md §«Stock»`). Mutations на этой итерации не
 * реализованы — запись остатков идёт через `StockService.applyMovementInTx`
 * из приёмки и расхода материалов.
 */
@Module({
  controllers: [StockController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
