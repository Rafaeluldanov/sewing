import { Controller, Get, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import {
  ListStockBalancesQuerySchema,
  type ListStockBalancesQuery,
} from './dto/list-stock-balances.dto.js';
import {
  ListStockMovementsQuerySchema,
  type ListStockMovementsQuery,
} from './dto/list-stock-movements.dto.js';
import { StockService } from './stock.service.js';

/**
 * `/api/stock/*` — read-only API складского foundation
 * (см. `apps/api/src/modules/stock/stock.service.ts`,
 * `prisma/schema.prisma::StockBalance` / `StockMovement`,
 * `docs/api.md §«Stock»`).
 *
 *   GET /api/stock/balances   — текущие остатки по `WorkshopNeed`;
 *   GET /api/stock/movements  — журнал движений (IN / OUT / REVERSAL).
 *
 * Контроллер сознательно read-only: на этой итерации никаких mutations,
 * adjustment-эндпоинтов и flow-изменений (см. ТЗ «Backend-only stock
 * read API»). Запись остатков по-прежнему идёт через
 * `StockService.applyMovementInTx` из `PurchaseReceiptsService` и
 * `MaterialIssuesService` (приёмка / отмена приёмки / `MaterialIssue`
 * post / `AUTO_CUT_ISSUE`).
 *
 * RBAC: `@Roles('ADMIN', 'SHOP_MANAGER')`. Новые роли (`WAREHOUSE_MANAGER`,
 * `PURCHASER`, `ACCOUNTANT`) сознательно не вводятся в MVP — уровень
 * доступа совпадает с `MaterialIssuesController` /
 * `PurchaseReceiptsController`. `ADMIN` глобально проходит через
 * `AuthGuard` (см. `apps/api/src/modules/auth/auth.guard.ts`).
 *
 * Сознательная граница MVP:
 *   - `sourceKey` (внутренний идемпотентный ключ) в response **не
 *     возвращается**;
 *   - FIFO/LIFO нет; `MaterialStockLot` нет; master-модели `Material`
 *     нет — материал идентифицируется через `WorkshopNeed`;
 *   - публичных PATCH/POST для управления остатками нет.
 */
@Controller('stock')
@Roles('ADMIN', 'SHOP_MANAGER')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get('balances')
  listBalances(
    @Query(new ZodValidationPipe(ListStockBalancesQuerySchema))
    query: ListStockBalancesQuery,
  ) {
    return this.stock.listBalances(query);
  }

  @Get('movements')
  listMovements(
    @Query(new ZodValidationPipe(ListStockMovementsQuerySchema))
    query: ListStockMovementsQuery,
  ) {
    return this.stock.listMovements(query);
  }
}
