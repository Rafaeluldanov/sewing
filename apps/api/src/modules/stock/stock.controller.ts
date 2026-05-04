import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import {
  CreateStockAdjustmentSchema,
  type CreateStockAdjustmentDto,
} from './dto/create-stock-adjustment.dto.js';
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
 * `/api/stock/*` — API складского foundation
 * (см. `apps/api/src/modules/stock/stock.service.ts`,
 * `prisma/schema.prisma::StockBalance` / `StockMovement`,
 * `docs/api.md §«Stock»`).
 *
 *   GET  /api/stock/balances     — текущие остатки по `WorkshopNeed`;
 *   GET  /api/stock/movements    — журнал движений (IN / OUT / REVERSAL / ADJUSTMENT);
 *   POST /api/stock/adjustments  — ручная корректировка остатка
 *                                  (`StockMovement` `type = ADJUSTMENT`).
 *
 * На этой итерации добавлен ровно один mutation-эндпоинт —
 * `POST /api/stock/adjustments`. Запись остатков по `PurchaseReceipt`
 * (POSTED → IN, cancel → REVERSAL OUT) и `MaterialIssue` (POSTED → OUT,
 * включая `AUTO_CUT_ISSUE`) по-прежнему идёт неявно, в той же
 * транзакции, что и бизнес-документ — `StockService.applyMovementInTx`
 * из `PurchaseReceiptsService` / `MaterialIssuesService`. Никаких
 * transfer / FIFO/LIFO / `MaterialStockLot` / master-`Material` не
 * вводим (см. ТЗ).
 *
 * RBAC: `@Roles('ADMIN', 'SHOP_MANAGER')`. Новые складские/закупочные/
 * бухгалтерские роли на этой итерации не вводятся — уровень доступа
 * совпадает с `MaterialIssuesController` / `PurchaseReceiptsController`.
 * `ADMIN` глобально проходит через `AuthGuard`
 * (см. `apps/api/src/modules/auth/auth.guard.ts`).
 *
 * Сознательная граница MVP:
 *   - `sourceKey` (внутренний идемпотентный ключ) в response **не
 *     возвращается**;
 *   - FIFO/LIFO нет; `MaterialStockLot` нет; master-модели `Material`
 *     нет — материал идентифицируется через `WorkshopNeed`;
 *   - `delete` / `cancel` adjustment в этой итерации **не реализованы**.
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

  /**
   * Ручная корректировка остатка материала. Создаёт `StockMovement`
   * с `type = ADJUSTMENT` и `direction = IN | OUT`, апдейтит
   * `StockBalance` и пишет audit `STOCK_ADJUSTMENT_CREATED` в одной
   * транзакции (см. `StockService.createAdjustment`).
   *
   * Идемпотентность: один `clientRequestId` формы → одно
   * `StockMovement` (`sourceKey = STOCK_ADJUSTMENT:<clientRequestId>`).
   * Если `clientRequestId` не передан — сервер генерирует свой,
   * чтобы `sourceKey` всегда оставался уникальным.
   */
  @Post('adjustments')
  @HttpCode(HttpStatus.CREATED)
  createAdjustment(
    @Body(new ZodValidationPipe(CreateStockAdjustmentSchema))
    body: CreateStockAdjustmentDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.stock.createAdjustment(body, user.employeeId);
  }
}
