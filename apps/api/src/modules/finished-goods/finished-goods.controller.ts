import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import {
  CancelFinishedGoodsShipmentSchema,
  type CancelFinishedGoodsShipmentDto,
} from './dto/cancel-finished-goods-shipment.dto.js';
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

  @Get('balances')
  listBalances(
    @Query(new ZodValidationPipe(ListFinishedGoodsBalancesQuerySchema))
    query: ListFinishedGoodsBalancesQuery,
  ) {
    return this.finishedGoods.listBalances(query);
  }

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
}
