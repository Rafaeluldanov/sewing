import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type StockBalance, type StockMovement } from '@prisma/client';

import { BusinessException } from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ListStockBalancesQuery } from './dto/list-stock-balances.dto.js';
import type { ListStockMovementsQuery } from './dto/list-stock-movements.dto.js';
import {
  STOCK_MOVEMENT_DIRECTION,
  type StockMovementDirection,
  type StockMovementType,
} from './stock.constants.js';

export type GetOrCreateBalanceInTxParams = {
  workshopNeedId: string;
  warehouseId?: string | null;
  cellId?: string | null;
  description: string;
  materialRole?: string | null;
  unit: string;
};

export type ApplyMovementInTxParams = {
  workshopNeedId: string;
  warehouseId?: string | null;
  cellId?: string | null;
  /** Подпись остатка при первом создании `StockBalance`. */
  description: string;
  materialRole?: string | null;
  type: StockMovementType | string;
  direction: StockMovementDirection | string;
  qty: Prisma.Decimal;
  unit: string;
  /** Для `IN` — цена поступления; для `OUT` игнорируется при расчёте, в движении пишется `balance.unitCost`. */
  unitCost: Prisma.Decimal;
  sourceType?: string | null;
  sourceId?: string | null;
  purchaseReceiptId?: string | null;
  purchaseReceiptLineId?: string | null;
  materialIssueId?: string | null;
  materialIssueLineId?: string | null;
  comment?: string | null;
  createdById?: string | null;
};

/**
 * Детерминированный ключ остатка: избегает нескольких строк с
 * `(workshopNeedId, NULL warehouse, NULL cell)` в SQL UNIQUE.
 */
export function buildStockBalanceKey(
  workshopNeedId: string,
  warehouseId: string | null | undefined,
  cellId: string | null | undefined,
): string {
  return `${workshopNeedId}:${warehouseId ?? 'NO_WAREHOUSE'}:${cellId ?? 'NO_CELL'}`;
}

/**
 * Сервис foundation складского учёта по `WorkshopNeed`.
 *
 * **Стоимость на остатке (без FIFO):**
 * - `IN` — средневзвешенная: `newTotal = oldTotal + qty×unitCost`,
 *   затем `unitCost = newTotal / newQty` при `newQty > 0`, иначе нули.
 * - `OUT` — `unitCost` остатка не меняем; `totalCost = newQty × unitCost`
 *   (пропорционально текущей средней). При `newQty < 0` итоговая
 *   стоимость может уйти в минус — **не клампим** (foundation).
 */
@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  async listBalances(query: ListStockBalancesQuery) {
    const take = query.take ?? 50;
    const skip = query.skip ?? 0;
    const where: Prisma.StockBalanceWhereInput = {
      ...(query.workshopNeedId ? { workshopNeedId: query.workshopNeedId } : {}),
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.cellId ? { cellId: query.cellId } : {}),
    };
    return this.prisma.stockBalance.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take,
      skip,
    });
  }

  async listMovements(query: ListStockMovementsQuery) {
    const take = query.take ?? 50;
    const skip = query.skip ?? 0;
    const where: Prisma.StockMovementWhereInput = {
      ...(query.workshopNeedId ? { workshopNeedId: query.workshopNeedId } : {}),
      ...(query.stockBalanceId ? { stockBalanceId: query.stockBalanceId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
    };
    return this.prisma.stockMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    });
  }

  async getOrCreateBalanceInTx(
    tx: Prisma.TransactionClient,
    params: GetOrCreateBalanceInTxParams,
  ) {
    const balanceKey = buildStockBalanceKey(
      params.workshopNeedId,
      params.warehouseId,
      params.cellId,
    );
    const existing = await tx.stockBalance.findUnique({
      where: { balanceKey },
    });
    if (existing) {
      return existing;
    }
    try {
      return await tx.stockBalance.create({
        data: {
          balanceKey,
          workshopNeedId: params.workshopNeedId,
          warehouseId: params.warehouseId ?? null,
          cellId: params.cellId ?? null,
          description: params.description,
          materialRole: params.materialRole ?? null,
          unit: params.unit,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return tx.stockBalance.findUniqueOrThrow({ where: { balanceKey } });
      }
      throw err;
    }
  }

  async applyMovementInTx(
    tx: Prisma.TransactionClient,
    params: ApplyMovementInTxParams,
  ): Promise<{ movement: StockMovement; balance: StockBalance }> {
    if (params.qty.lte(0)) {
      throw new BusinessException(
        'STOCK_MOVEMENT_QTY_INVALID',
        'Количество движения должно быть больше нуля.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      params.direction !== STOCK_MOVEMENT_DIRECTION.IN &&
      params.direction !== STOCK_MOVEMENT_DIRECTION.OUT
    ) {
      throw new BusinessException(
        'STOCK_MOVEMENT_DIRECTION_INVALID',
        'Недопустимое направление движения (ожидается IN или OUT).',
        HttpStatus.BAD_REQUEST,
      );
    }

    const balance = await this.getOrCreateBalanceInTx(tx, {
      workshopNeedId: params.workshopNeedId,
      warehouseId: params.warehouseId,
      cellId: params.cellId,
      description: params.description,
      materialRole: params.materialRole ?? null,
      unit: params.unit,
    });

    if (balance.unit !== params.unit) {
      throw new BusinessException(
        'STOCK_BALANCE_UNIT_MISMATCH',
        'Единица движения не совпадает с единицей существующего остатка.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const balanceBeforeQty = balance.qty;
    const isIn = params.direction === STOCK_MOVEMENT_DIRECTION.IN;
    const movementUnitCost = isIn
      ? params.unitCost
      : balance.unitCost;
    const movementLineTotalCost = params.qty.mul(movementUnitCost);

    let balanceAfterQty: Prisma.Decimal;
    if (isIn) {
      balanceAfterQty = balanceBeforeQty.add(params.qty);
    } else {
      balanceAfterQty = balanceBeforeQty.sub(params.qty);
    }

    let newUnitCost: Prisma.Decimal;
    let newTotalCost: Prisma.Decimal;

    if (isIn) {
      const oldTotal = balance.totalCost;
      newTotalCost = oldTotal.add(movementLineTotalCost);
      if (balanceAfterQty.eq(0)) {
        newUnitCost = new Prisma.Decimal(0);
        newTotalCost = new Prisma.Decimal(0);
      } else {
        newUnitCost = newTotalCost.div(balanceAfterQty);
      }
    } else {
      const uc = balance.unitCost;
      newUnitCost = uc;
      newTotalCost = balanceAfterQty.mul(uc);
      if (balanceAfterQty.eq(0)) {
        newUnitCost = new Prisma.Decimal(0);
        newTotalCost = new Prisma.Decimal(0);
      }
    }

    const movement = await tx.stockMovement.create({
      data: {
        stockBalanceId: balance.id,
        workshopNeedId: params.workshopNeedId,
        type: params.type,
        direction: params.direction,
        warehouseId: params.warehouseId ?? null,
        cellId: params.cellId ?? null,
        qty: params.qty,
        unit: params.unit,
        unitCost: movementUnitCost,
        totalCost: movementLineTotalCost,
        balanceBeforeQty,
        balanceAfterQty,
        sourceType: params.sourceType ?? null,
        sourceId: params.sourceId ?? null,
        purchaseReceiptId: params.purchaseReceiptId ?? null,
        purchaseReceiptLineId: params.purchaseReceiptLineId ?? null,
        materialIssueId: params.materialIssueId ?? null,
        materialIssueLineId: params.materialIssueLineId ?? null,
        comment: params.comment ?? null,
        createdById: params.createdById ?? null,
      },
    });

    const updated = await tx.stockBalance.update({
      where: { id: balance.id },
      data: {
        qty: balanceAfterQty,
        unitCost: newUnitCost,
        totalCost: newTotalCost,
        lastMovementAt: new Date(),
      },
    });

    return { movement, balance: updated };
  }
}
