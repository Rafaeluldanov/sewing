import { Module } from '@nestjs/common';

import { StockService } from './stock.service.js';

/**
 * Foundation складского учёта материалов (`StockBalance` / `StockMovement`).
 * Публичных HTTP-роутов на этой итерации нет — только сервис для
 * будущих вызовов из приёмки / расхода.
 */
@Module({
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
