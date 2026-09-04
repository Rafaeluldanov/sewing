import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import {
  CancelFinishedGoodsShipmentSchema,
  type CancelFinishedGoodsShipmentDto,
} from './dto/cancel-finished-goods-shipment.dto.js';
import {
  CreateFinishedGoodsAdjustmentSchema,
  type CreateFinishedGoodsAdjustmentDto,
} from './dto/create-finished-goods-adjustment.dto.js';
import {
  CreateFinishedGoodsTransferSchema,
  type CreateFinishedGoodsTransferDto,
} from './dto/create-finished-goods-transfer.dto.js';
import {
  ListFinishedGoodsBalancesQuerySchema,
  type ListFinishedGoodsBalancesQuery,
} from './dto/list-finished-goods-balances.dto.js';
import {
  ListFinishedGoodsMovementsQuerySchema,
  type ListFinishedGoodsMovementsQuery,
} from './dto/list-finished-goods-movements.dto.js';
import { FinishedGoodsService } from './finished-goods.service.js';

/**
 * Read-only API foundation готовой продукции (см.
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts`,
 * `prisma/schema.prisma::FinishedGoodsBalance` / `FinishedGoodsMovement`,
 * `docs/api.md §«Finished goods»`,
 * `docs/current-state.md §«Готовая продукция»`).
 *
 *   GET /api/finished-goods/balances  — текущие остатки готовой продукции;
 *   GET /api/finished-goods/movements — журнал движений (PRODUCTION_RECEIPT IN на MVP).
 *
 * **Отдельный контур от материалов** — не путать с `/api/stock/*`.
 *
 * Запись движений идёт неявно, в той же транзакции, что и
 * `Passport.status = PACKED` (см.
 * `apps/api/src/modules/packing/packing.service.ts::addPassport` →
 * `FinishedGoodsService.recordPackedPassportInTx`). Публичных
 * мутаций на этой итерации нет (отгрузка / transfer / adjustment —
 * следующие итерации).
 *
 * RBAC: `@Roles('ADMIN', 'SHOP_MANAGER')`. `sourceKey` сознательно
 * не отдаётся — внутренний идемпотентный ключ.
 */
@Controller('finished-goods')
@Roles('ADMIN', 'SHOP_MANAGER')
export class FinishedGoodsController {
  constructor(private readonly finishedGoods: FinishedGoodsService) {}

  // Остаток готовой продукции ЦЕХА. ERP приходует ту же продукцию к себе документом
  // производства (§0.11), и без чтения этого остатка двойной учёт не с чем сверить.
  @MachineScopes('stock:read')
  @Get('balances')
  listBalances(
    @Query(new ZodValidationPipe(ListFinishedGoodsBalancesQuerySchema))
    query: ListFinishedGoodsBalancesQuery,
  ) {
    return this.finishedGoods.listBalances(query);
  }

  @MachineScopes('stock:read')
  @Get('movements')
  listMovements(
    @Query(new ZodValidationPipe(ListFinishedGoodsMovementsQuerySchema))
    query: ListFinishedGoodsMovementsQuery,
  ) {
    return this.finishedGoods.listMovements(query);
  }

  /**
   * Detail документа отгрузки готовой продукции (см.
   * `FinishedGoodsService.createShipmentForOrder`,
   * `apps/api/src/modules/finished-goods/finished-goods-order-shipments.controller.ts`).
   *
   * Создание / список по заказу живут на
   * `/api/orders/:orderId/finished-goods-shipments` в
   * `FinishedGoodsOrderShipmentsController`. Detail полезен для
   * перехода с любого UI (movement journal, audit log) и для тестов.
   */
  @MachineScopes('stock:read')
  @Get('shipments/:id')
  getShipment(@Param('id') id: string) {
    return this.finishedGoods.getShipmentDetail(id);
  }

  /**
   * Отмена документа отгрузки готовой продукции (см.
   * `FinishedGoodsService.cancelShipment`,
   * `docs/api.md §«Finished goods shipments»`).
   *
   * Тело — `{ reason }`, body-only DTO. Идемпотентно по
   * `shipment.status === 'CANCELLED'`. По каждой строке создаётся
   * `FinishedGoodsMovement` `type = REVERSAL, direction = IN`
   * (sourceKey `FINISHED_GOODS_SHIPMENT_CANCEL_LINE:<lineId>`),
   * `FinishedGoodsBalance.qty` атомарно увеличивается обратно.
   *
   * RBAC — `ADMIN` / `SHOP_MANAGER` (наследуется от `@Roles` на
   * классе).
   */
  @Post('shipments/:id/cancel')
  cancelShipment(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelFinishedGoodsShipmentSchema))
    dto: CancelFinishedGoodsShipmentDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.finishedGoods.cancelShipment(id, dto, user.employeeId);
  }

  /**
   * Перемещение готовой продукции между складами / ячейками. Пишет
   * пару `FinishedGoodsMovement` `type = TRANSFER` (`OUT` из источника
   * + `IN` в назначение) и audit `FINISHED_GOODS_TRANSFER_CREATED` в
   * одной транзакции (см. `FinishedGoodsService.createTransfer`,
   * `apps/api/src/modules/finished-goods/dto/create-finished-goods-transfer.dto.ts`,
   * UI — `/admin/warehouses?tab=balances`, кнопка «Переместить» для
   * выбранного остатка готовой продукции).
   *
   * Контракт MVP-итерации:
   *   - transfer всегда strict — недостаток источника отдаёт 409
   *     `FINISHED_GOODS_INSUFFICIENT_BALANCE`;
   *   - same source/destination → 409
   *     `FINISHED_GOODS_TRANSFER_SAME_LOCATION`;
   *   - идемпотентность по `clientRequestId`: повторный submit с тем
   *     же `clientRequestId` возвращает существующую пару движений и
   *     не апдейтит балансы повторно;
   *   - response — `{ transferId, outMovement, inMovement }` в shape
   *     `FinishedGoodsMovementListItem`. `sourceKey` сознательно НЕ
   *     отдаём (`toMovementListItem` его вырезает);
   *   - НЕ создаём отдельную модель `FinishedGoodsTransfer`; transfer
   *     представлен парой `FinishedGoodsMovement` `type = TRANSFER`.
   *
   * RBAC — `ADMIN` / `SHOP_MANAGER` (наследуется от `@Roles` на
   * классе).
   */
  @Post('transfers')
  @HttpCode(HttpStatus.CREATED)
  createTransfer(
    @Body(new ZodValidationPipe(CreateFinishedGoodsTransferSchema))
    body: CreateFinishedGoodsTransferDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.finishedGoods.createTransfer(body, user.employeeId);
  }

  /**
   * Ручная корректировка остатка готовой продукции. Пишет одно
   * `FinishedGoodsMovement` `type = ADJUSTMENT` (`direction = IN |
   * OUT`) и audit `FINISHED_GOODS_ADJUSTMENT_CREATED` в одной
   * транзакции (см. `FinishedGoodsService.createAdjustment`,
   * `apps/api/src/modules/finished-goods/dto/create-finished-goods-adjustment.dto.ts`,
   * UI — `/admin/warehouses?tab=balances`, кнопка «Корректировка»
   * для выбранного остатка готовой продукции).
   *
   * Контракт MVP-итерации:
   *   - `qty` всегда целое положительное (готовая продукция
   *     штучная);
   *   - `OUT` всегда strict — недостаток источника отдаёт 409
   *     `FINISHED_GOODS_INSUFFICIENT_BALANCE`. Готовая продукция не
   *     уходит в минус, аналога `allowNegativeMaterialStock` нет;
   *   - идемпотентность по `clientRequestId`: повторный submit с тем
   *     же ключом возвращает существующее движение и не апдейтит
   *     баланс повторно;
   *   - response — `FinishedGoodsMovementListItem`. `sourceKey`
   *     сознательно НЕ отдаём (внутренний идемпотентный технический
   *     ключ);
   *   - НЕ создаём отдельную модель `FinishedGoodsAdjustment`;
   *     корректировка представлена одним `FinishedGoodsMovement`.
   *
   * RBAC — `ADMIN` / `SHOP_MANAGER` (наследуется от `@Roles` на
   * классе).
   */
  @Post('adjustments')
  @HttpCode(HttpStatus.CREATED)
  createAdjustment(
    @Body(new ZodValidationPipe(CreateFinishedGoodsAdjustmentSchema))
    body: CreateFinishedGoodsAdjustmentDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.finishedGoods.createAdjustment(body, user.employeeId);
  }
}
