import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type WorkInProgressBalance,
  type WorkInProgressMovement,
} from '@prisma/client';

import { normalizeColor } from '@sewing/shared/colors';

import { BusinessException } from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  WORK_IN_PROGRESS_MOVEMENT_DIRECTION,
  WORK_IN_PROGRESS_MOVEMENT_TYPE,
  WORK_IN_PROGRESS_SOURCE_TYPE,
  buildWorkInProgressBalanceKey,
  buildWorkInProgressSourceKey,
  type WorkInProgressMovementDirection,
  type WorkInProgressMovementType,
} from './work-in-progress.constants.js';
import type { ListWorkInProgressBalancesQuery } from './dto/list-work-in-progress-balances.dto.js';
import type { ListWorkInProgressMovementsQuery } from './dto/list-work-in-progress-movements.dto.js';

export type GetOrCreateWipBalanceParams = {
  orderId: string;
  productId: string;
  sizeId: string;
  color: string;
  warehouseId?: string | null;
  cellId?: string | null;
};

export type ApplyWipMovementParams = {
  orderId: string;
  productId: string;
  sizeId: string;
  color: string;
  warehouseId?: string | null;
  cellId?: string | null;
  type: WorkInProgressMovementType;
  direction: WorkInProgressMovementDirection;
  qty: number;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceKey?: string | null;
  passportId?: string | null;
  comment?: string | null;
  createdById?: string | null;
};

/**
 * Foundation учёта полуфабриката (крой) — паспорта, лежащие в
 * ячейках после раскроя и до выдачи в пошив (см.
 * `prisma/schema.prisma::WorkInProgressBalance` /
 * `WorkInProgressMovement`).
 *
 * **Отдельный контур** от материалов (`StockBalance`) и готовой
 * продукции (`FinishedGoodsBalance`). Триггеры:
 *   - `PassportsService.place`           → `PLACE`   (`IN`)
 *   - `PassportsService.issueToEmployee` → `ISSUE`   (`OUT`)
 *   - `MasterActionsService.returnToCell`/`setRouteStep` backward
 *                                        → `RETURN`  (`IN`)
 *   - `PassportsService.delete`          → `DELETE`  (`OUT`)
 *   - `PackingService.addPassport`       → `PACK_OUT` (`OUT`),
 *     defensive если паспорт пакуется прямо из ячейки.
 *
 * `recordXxxInTx`-методы вызываются из той же транзакции, что и
 * обновление `Passport.currentCellId` / `CellContent.quantity`,
 * чтобы исключить дрейф между WIP balance и legacy CellContent
 * cache.
 *
 * Идемпотентность: `WorkInProgressMovement.sourceKey @unique`. Формат
 * ключа — `WIP_<TYPE>:<sourceId>`, где `sourceId` — `PassportEvent.id`
 * для PLACE/ISSUE, `AuditLog.id` для RETURN, `passportId` для DELETE
 * (паспорт удаляется, ключ остаётся уникальным).
 */
@Injectable()
export class WorkInProgressService {
  private readonly logger = new Logger(WorkInProgressService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // INTERNAL CORE
  // ===========================================================================

  /**
   * Найти / создать `WorkInProgressBalance` по детерминированному
   * ключу. Безопасен относительно гонок (P2002 → re-fetch).
   */
  async getOrCreateBalanceInTx(
    tx: Prisma.TransactionClient,
    params: GetOrCreateWipBalanceParams,
  ): Promise<WorkInProgressBalance> {
    const balanceKey = buildWorkInProgressBalanceKey(params);
    const existing = await tx.workInProgressBalance.findUnique({
      where: { balanceKey },
    });
    if (existing) return existing;
    try {
      return await tx.workInProgressBalance.create({
        data: {
          balanceKey,
          orderId: params.orderId,
          productId: params.productId,
          sizeId: params.sizeId,
          color: normalizeColor(params.color),
          warehouseId: params.warehouseId ?? null,
          cellId: params.cellId ?? null,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return tx.workInProgressBalance.findUniqueOrThrow({
          where: { balanceKey },
        });
      }
      throw err;
    }
  }

  /**
   * Применить движение и обновить баланс в той же транзакции.
   *
   * Контракт:
   *   - `qty > 0`, `direction ∈ {IN, OUT}`;
   *   - `sourceKey` идемпотентен: повторный вызов с тем же ключом
   *     возвращает существующее движение и НЕ меняет баланс;
   *   - OUT не уводит баланс ниже нуля — иначе 409.
   */
  async applyMovementInTx(
    tx: Prisma.TransactionClient,
    params: ApplyWipMovementParams,
  ): Promise<{
    movement: WorkInProgressMovement;
    balance: WorkInProgressBalance;
    idempotent: boolean;
  }> {
    if (!Number.isInteger(params.qty) || params.qty <= 0) {
      throw new BusinessException(
        'WIP_MOVEMENT_QTY_INVALID',
        'Количество движения полуфабриката должно быть целым положительным числом.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      params.direction !== WORK_IN_PROGRESS_MOVEMENT_DIRECTION.IN &&
      params.direction !== WORK_IN_PROGRESS_MOVEMENT_DIRECTION.OUT
    ) {
      throw new BusinessException(
        'WIP_MOVEMENT_DIRECTION_INVALID',
        'Недопустимое направление движения полуфабриката (ожидается IN или OUT).',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (params.sourceKey) {
      const existing = await tx.workInProgressMovement.findUnique({
        where: { sourceKey: params.sourceKey },
      });
      if (existing) {
        const balance = existing.workInProgressBalanceId
          ? await tx.workInProgressBalance.findUnique({
              where: { id: existing.workInProgressBalanceId },
            })
          : await this.getOrCreateBalanceInTx(tx, params);
        return {
          movement: existing,
          balance: balance ?? (await this.getOrCreateBalanceInTx(tx, params)),
          idempotent: true,
        };
      }
    }

    const balance = await this.getOrCreateBalanceInTx(tx, params);

    const isIn = params.direction === WORK_IN_PROGRESS_MOVEMENT_DIRECTION.IN;
    const balanceBeforeQty = balance.qty;
    const balanceAfterQty = isIn
      ? balanceBeforeQty + params.qty
      : balanceBeforeQty - params.qty;

    if (!isIn && balanceAfterQty < 0) {
      // Полуфабрикат не уходит в минус: если такое случилось, это
      // признак рассинхронизации — лучше упасть, чем тихо прятать.
      throw new BusinessException(
        'WIP_INSUFFICIENT_BALANCE',
        `Недостаточно остатка полуфабриката: доступно ${balanceBeforeQty}, требуется ${params.qty}.`,
        HttpStatus.CONFLICT,
      );
    }

    const movement = await tx.workInProgressMovement.create({
      data: {
        workInProgressBalanceId: balance.id,
        type: params.type,
        direction: params.direction,
        orderId: params.orderId,
        productId: params.productId,
        sizeId: params.sizeId,
        color: normalizeColor(params.color),
        warehouseId: params.warehouseId ?? null,
        cellId: params.cellId ?? null,
        qty: params.qty,
        balanceBeforeQty,
        balanceAfterQty,
        sourceType: params.sourceType ?? null,
        sourceId: params.sourceId ?? null,
        sourceKey: params.sourceKey ?? null,
        passportId: params.passportId ?? null,
        comment: params.comment ?? null,
        createdById: params.createdById ?? null,
      },
    });

    const updated = await tx.workInProgressBalance.update({
      where: { id: balance.id },
      data: {
        qty: balanceAfterQty,
        lastMovementAt: new Date(),
      },
    });

    return { movement, balance: updated, idempotent: false };
  }

  // ===========================================================================
  // PUBLIC RECORDERS — вызываются из PassportsService / MasterActionsService /
  // PackingService в той же транзакции, что и изменение паспорта/CellContent.
  // ===========================================================================

  /**
   * Зарегистрировать размещение паспорта в ячейку.
   *
   * Идемпотентно по `sourceKey = WIP_PLACE:<eventId>`. `eventId` —
   * id `PassportEvent` типа `PASSPORT_PLACED`, который пишет
   * `PassportsService.place` в той же транзакции.
   */
  async recordPlaceInTx(
    tx: Prisma.TransactionClient,
    params: {
      passport: {
        id: string;
        orderId: string;
        productId: string;
        sizeId: string;
        color: string;
        qtyCut: number;
      };
      cell: { id: string; warehouseId: string | null };
      eventId: string;
      employeeId: string | null;
    },
  ): Promise<void> {
    if (params.passport.qtyCut <= 0) return;
    await this.applyMovementInTx(tx, {
      orderId: params.passport.orderId,
      productId: params.passport.productId,
      sizeId: params.passport.sizeId,
      color: params.passport.color,
      warehouseId: params.cell.warehouseId,
      cellId: params.cell.id,
      type: WORK_IN_PROGRESS_MOVEMENT_TYPE.PLACE,
      direction: WORK_IN_PROGRESS_MOVEMENT_DIRECTION.IN,
      qty: params.passport.qtyCut,
      sourceType: WORK_IN_PROGRESS_SOURCE_TYPE.PASSPORT_EVENT,
      sourceId: params.eventId,
      sourceKey: buildWorkInProgressSourceKey(
        WORK_IN_PROGRESS_MOVEMENT_TYPE.PLACE,
        params.eventId,
      ),
      passportId: params.passport.id,
      createdById: params.employeeId,
    });
  }

  /**
   * Зарегистрировать выдачу паспорта швее (списание из ячейки).
   *
   * Идемпотентно по `sourceKey = WIP_ISSUE:<eventId>`.
   */
  async recordIssueInTx(
    tx: Prisma.TransactionClient,
    params: {
      passport: {
        id: string;
        orderId: string;
        productId: string;
        sizeId: string;
        color: string;
        qtyCut: number;
      };
      fromCell: { id: string; warehouseId: string | null };
      eventId: string;
      employeeId: string | null;
    },
  ): Promise<void> {
    if (params.passport.qtyCut <= 0) return;
    await this.applyMovementInTx(tx, {
      orderId: params.passport.orderId,
      productId: params.passport.productId,
      sizeId: params.passport.sizeId,
      color: params.passport.color,
      warehouseId: params.fromCell.warehouseId,
      cellId: params.fromCell.id,
      type: WORK_IN_PROGRESS_MOVEMENT_TYPE.ISSUE,
      direction: WORK_IN_PROGRESS_MOVEMENT_DIRECTION.OUT,
      qty: params.passport.qtyCut,
      sourceType: WORK_IN_PROGRESS_SOURCE_TYPE.PASSPORT_EVENT,
      sourceId: params.eventId,
      sourceKey: buildWorkInProgressSourceKey(
        WORK_IN_PROGRESS_MOVEMENT_TYPE.ISSUE,
        params.eventId,
      ),
      passportId: params.passport.id,
      createdById: params.employeeId,
    });
  }

  /**
   * Зарегистрировать возврат паспорта в ячейку master-action'ом.
   *
   * Идемпотентно по `sourceKey = WIP_RETURN:<auditId>`. `auditId` —
   * id audit-записи `MASTER_PASSPORT_RETURNED_TO_CELL` или
   * `MASTER_PASSPORT_ROUTE_STEP_SET` (когда backward + cellId).
   */
  async recordReturnInTx(
    tx: Prisma.TransactionClient,
    params: {
      passport: {
        id: string;
        orderId: string;
        productId: string;
        sizeId: string;
        color: string;
        qtyCut: number;
      };
      cell: { id: string; warehouseId: string | null };
      auditId: string;
      employeeId: string | null;
    },
  ): Promise<void> {
    if (params.passport.qtyCut <= 0) return;
    await this.applyMovementInTx(tx, {
      orderId: params.passport.orderId,
      productId: params.passport.productId,
      sizeId: params.passport.sizeId,
      color: params.passport.color,
      warehouseId: params.cell.warehouseId,
      cellId: params.cell.id,
      type: WORK_IN_PROGRESS_MOVEMENT_TYPE.RETURN,
      direction: WORK_IN_PROGRESS_MOVEMENT_DIRECTION.IN,
      qty: params.passport.qtyCut,
      sourceType: WORK_IN_PROGRESS_SOURCE_TYPE.MASTER_AUDIT,
      sourceId: params.auditId,
      sourceKey: buildWorkInProgressSourceKey(
        WORK_IN_PROGRESS_MOVEMENT_TYPE.RETURN,
        params.auditId,
      ),
      passportId: params.passport.id,
      createdById: params.employeeId,
    });
  }

  /**
   * Зарегистрировать списание остатка кроя при удалении паспорта,
   * лежавшего в ячейке.
   *
   * Идемпотентно по `sourceKey = WIP_DELETE:<passportId>`. После
   * `delete` паспорт исчезает, поэтому `passportId` уникален навсегда —
   * `Passport.id` cuid не переиспользуется.
   */
  async recordDeleteInTx(
    tx: Prisma.TransactionClient,
    params: {
      passport: {
        id: string;
        orderId: string;
        productId: string;
        sizeId: string;
        color: string;
        qtyCut: number;
      };
      fromCell: { id: string; warehouseId: string | null };
      employeeId: string | null;
    },
  ): Promise<void> {
    if (params.passport.qtyCut <= 0) return;
    await this.applyMovementInTx(tx, {
      orderId: params.passport.orderId,
      productId: params.passport.productId,
      sizeId: params.passport.sizeId,
      color: params.passport.color,
      warehouseId: params.fromCell.warehouseId,
      cellId: params.fromCell.id,
      type: WORK_IN_PROGRESS_MOVEMENT_TYPE.DELETE,
      direction: WORK_IN_PROGRESS_MOVEMENT_DIRECTION.OUT,
      qty: params.passport.qtyCut,
      sourceType: WORK_IN_PROGRESS_SOURCE_TYPE.PASSPORT_DELETE,
      sourceId: params.passport.id,
      sourceKey: buildWorkInProgressSourceKey(
        WORK_IN_PROGRESS_MOVEMENT_TYPE.DELETE,
        params.passport.id,
      ),
      passportId: params.passport.id,
      createdById: params.employeeId,
    });
  }

  /**
   * Defensive: списание остатка кроя при упаковке паспорта прямо из
   * ячейки (`PackingService.addPassport`). Нормальный flow проходит
   * через `issueToEmployee` сначала, и `currentCellId` уже null —
   * для этого случая метод тихий no-op (см. вызывающий код, он
   * проверяет `currentCellId != null`).
   *
   * Идемпотентно по `sourceKey = WIP_PACK_OUT:<passportId>`.
   */
  async recordPackOutInTx(
    tx: Prisma.TransactionClient,
    params: {
      passport: {
        id: string;
        orderId: string;
        productId: string;
        sizeId: string;
        color: string;
        qtyCut: number;
      };
      fromCell: { id: string; warehouseId: string | null };
      employeeId: string | null;
    },
  ): Promise<void> {
    if (params.passport.qtyCut <= 0) return;
    await this.applyMovementInTx(tx, {
      orderId: params.passport.orderId,
      productId: params.passport.productId,
      sizeId: params.passport.sizeId,
      color: params.passport.color,
      warehouseId: params.fromCell.warehouseId,
      cellId: params.fromCell.id,
      type: WORK_IN_PROGRESS_MOVEMENT_TYPE.PACK_OUT,
      direction: WORK_IN_PROGRESS_MOVEMENT_DIRECTION.OUT,
      qty: params.passport.qtyCut,
      sourceType: WORK_IN_PROGRESS_SOURCE_TYPE.PASSPORT_PACK,
      sourceId: params.passport.id,
      sourceKey: buildWorkInProgressSourceKey(
        WORK_IN_PROGRESS_MOVEMENT_TYPE.PACK_OUT,
        params.passport.id,
      ),
      passportId: params.passport.id,
      createdById: params.employeeId,
    });
  }

  // ===========================================================================
  // READ-ONLY API
  // ===========================================================================

  async listBalances(query: ListWorkInProgressBalancesQuery) {
    const where: Prisma.WorkInProgressBalanceWhereInput = {};
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.cellId) where.cellId = query.cellId;
    if (query.orderId) where.orderId = query.orderId;
    if (query.productId) where.productId = query.productId;
    if (query.sizeId) where.sizeId = query.sizeId;
    if (query.color) where.color = query.color;
    if (query.nonZero) where.qty = { gt: 0 };

    const take = Math.min(Math.max(query.take ?? 100, 1), 500);
    const skip = Math.max(query.skip ?? 0, 0);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.workInProgressBalance.findMany({
        where,
        include: {
          order: { select: { id: true, number: true, color: true } },
          product: { select: { id: true, name: true } },
          size: { select: { id: true, code: true } },
          warehouse: { select: { id: true, name: true, code: true } },
          cell: { select: { id: true, code: true } },
        },
        orderBy: [{ updatedAt: 'desc' }],
        take,
        skip,
      }),
      this.prisma.workInProgressBalance.count({ where }),
    ]);

    return {
      items: items.map((b) => ({
        id: b.id,
        orderId: b.orderId,
        orderNumber: b.order?.number ?? null,
        productId: b.productId,
        productName: b.product?.name ?? null,
        sizeId: b.sizeId,
        sizeCode: b.size?.code ?? null,
        color: b.color,
        warehouseId: b.warehouseId,
        warehouseName: b.warehouse?.name ?? null,
        cellId: b.cellId,
        cellCode: b.cell?.code ?? null,
        qty: b.qty,
        updatedAt: b.updatedAt.toISOString(),
        lastMovementAt: b.lastMovementAt?.toISOString() ?? null,
      })),
      total,
    };
  }

  async listMovements(query: ListWorkInProgressMovementsQuery) {
    const where: Prisma.WorkInProgressMovementWhereInput = {};
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.cellId) where.cellId = query.cellId;
    if (query.orderId) where.orderId = query.orderId;
    if (query.passportId) where.passportId = query.passportId;
    if (query.type) where.type = query.type;
    if (query.direction) where.direction = query.direction;

    const take = Math.min(Math.max(query.take ?? 100, 1), 500);
    const skip = Math.max(query.skip ?? 0, 0);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.workInProgressMovement.findMany({
        where,
        include: {
          order: { select: { id: true, number: true } },
          product: { select: { id: true, name: true } },
          size: { select: { id: true, code: true } },
          warehouse: { select: { id: true, name: true, code: true } },
          cell: { select: { id: true, code: true } },
          passport: { select: { id: true, number: true } },
        },
        orderBy: [{ createdAt: 'desc' }],
        take,
        skip,
      }),
      this.prisma.workInProgressMovement.count({ where }),
    ]);

    return {
      items: items.map((m) => ({
        id: m.id,
        type: m.type,
        direction: m.direction,
        orderId: m.orderId,
        orderNumber: m.order?.number ?? null,
        productId: m.productId,
        productName: m.product?.name ?? null,
        sizeId: m.sizeId,
        sizeCode: m.size?.code ?? null,
        color: m.color,
        warehouseId: m.warehouseId,
        warehouseName: m.warehouse?.name ?? null,
        cellId: m.cellId,
        cellCode: m.cell?.code ?? null,
        qty: m.qty,
        balanceBeforeQty: m.balanceBeforeQty,
        balanceAfterQty: m.balanceAfterQty,
        passportId: m.passportId,
        passportNumber: m.passport?.number ?? null,
        sourceType: m.sourceType,
        comment: m.comment,
        createdAt: m.createdAt.toISOString(),
      })),
      total,
    };
  }
}
