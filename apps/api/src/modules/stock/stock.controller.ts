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
  CreateStockTransferSchema,
  type CreateStockTransferDto,
} from './dto/create-stock-transfer.dto.js';
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
 *   GET  /api/stock/movements    — журнал движений (IN / OUT / REVERSAL / ADJUSTMENT / TRANSFER);
 *   POST /api/stock/adjustments  — ручная корректировка остатка
 *                                  (`StockMovement` `type = ADJUSTMENT`);
 *   POST /api/stock/transfers    — перемещение остатка между складами /
 *                                  ячейками (пара `StockMovement`
 *                                  `type = TRANSFER` `OUT` + `IN`).
 *
 * Запись остатков по `PurchaseReceipt` (POSTED → IN, cancel → REVERSAL
 * OUT) и `MaterialIssue` (POSTED → OUT, включая `AUTO_CUT_ISSUE`)
 * по-прежнему идёт неявно, в той же транзакции, что и бизнес-документ
 * — `StockService.applyMovementInTx` из `PurchaseReceiptsService` /
 * `MaterialIssuesService`. FIFO/LIFO / `MaterialStockLot` /
 * master-`Material` / отдельной модели `StockTransfer` сознательно
 * НЕ вводим (см. ТЗ).
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

  /**
   * Перемещение остатка между складами / ячейками. Пишет пару
   * `StockMovement` `type = TRANSFER` (`OUT` из источника + `IN` в
   * назначение) и audit `STOCK_TRANSFER_CREATED` в одной транзакции
   * (см. `StockService.createTransfer`,
   * `apps/api/src/modules/stock/dto/create-stock-transfer.dto.ts`,
   * UI — `/admin/warehouses?tab=balances`, кнопка «Переместить»).
   *
   * Контракт MVP-итерации:
   *   - transfer всегда strict — недостаток источника отдаёт 409
   *     `MATERIAL_STOCK_INSUFFICIENT`. `allowNegativeMaterialStock`
   *     НЕ используется;
   *   - same source/destination → 409 `STOCK_TRANSFER_SAME_LOCATION`;
   *   - идемпотентность по `clientRequestId`: повторный submit с тем
   *     же `clientRequestId` возвращает существующую пару движений и
   *     не апдейтит балансы повторно;
   *   - response — `{ transferId, outMovement, inMovement }` в shape
   *     `StockMovementListItem`. `sourceKey` сознательно НЕ отдаём
   *     (см. `StockService.toStockMovementListItem`);
   *   - НЕ создаём отдельную модель `StockTransfer`; transfer
   *     представлен парой `StockMovement` `type = TRANSFER`.
   */
  @Post('transfers')
  @HttpCode(HttpStatus.CREATED)
  createTransfer(
    @Body(new ZodValidationPipe(CreateStockTransferSchema))
    body: CreateStockTransferDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.stock.createTransfer(body, user.employeeId);
  }
}
