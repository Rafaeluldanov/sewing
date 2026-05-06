import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  PassportStatus,
  type FinishedGoodsBalance,
  type FinishedGoodsMovement,
} from '@prisma/client';

import { BusinessException } from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { ListFinishedGoodsBalancesQuery } from './dto/list-finished-goods-balances.dto.js';
import type { ListFinishedGoodsMovementsQuery } from './dto/list-finished-goods-movements.dto.js';
import {
  FINISHED_GOODS_MOVEMENT_DIRECTION,
  FINISHED_GOODS_MOVEMENT_TYPE,
  FINISHED_GOODS_SOURCE_TYPE,
  buildFinishedGoodsBalanceKey,
  buildPackedPassportSourceKey,
  type FinishedGoodsMovementDirection,
  type FinishedGoodsMovementType,
} from './finished-goods.constants.js';

export type GetOrCreateFinishedGoodsBalanceParams = {
  orderId: string;
  productId: string;
  sizeId: string;
  color: string;
  warehouseId?: string | null;
  cellId?: string | null;
};

export type ApplyFinishedGoodsMovementParams = {
  orderId: string;
  productId: string;
  sizeId: string;
  color: string;
  warehouseId?: string | null;
  cellId?: string | null;
  type: FinishedGoodsMovementType | string;
  direction: FinishedGoodsMovementDirection | string;
  qty: number;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceKey?: string | null;
  passportId?: string | null;
  boxId?: string | null;
  comment?: string | null;
  createdById?: string | null;
};

/**
 * Foundation учёта готовой продукции (см.
 * `prisma/schema.prisma::FinishedGoodsBalance` / `FinishedGoodsMovement`,
 * `docs/current-state.md §«Готовая продукция»`).
 *
 * **Отдельный контур от материалов.** `StockBalance` / `StockMovement`
 * / `MaterialIssue` / `PurchaseReceipt` / `StockAdjustment` /
 * `StockTransfer` / `CostsService` / `ProductionCostV2Service` в этом
 * сервисе не участвуют — материалы и готовые изделия живут в разных
 * таблицах.
 *
 * На MVP-итерации единственный реализованный type —
 * `PRODUCTION_RECEIPT` (`direction = IN`), создаётся
 * `recordPackedPassportInTx` в той же транзакции, что и
 * `Passport.status = PACKED` (см.
 * `apps/api/src/modules/packing/packing.service.ts::addPassport`).
 *
 * Идемпотентность — `FinishedGoodsMovement.sourceKey @unique`. Для
 * упаковки паспорта ключ — `PACKED_PASSPORT:<passportId>`. `sourceKey`
 * сознательно НЕ отдаём в read-only API (внутренний технический ключ).
 *
 * Если у заказа `Order.finishedGoodsWarehouseId = null`, ведём
 * «no-warehouse» баланс (`warehouseId = null`) — это не блокирует
 * упаковку.
 */
@Injectable()
export class FinishedGoodsService {
  private readonly logger = new Logger(FinishedGoodsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // READ-ONLY
  // ===========================================================================

  async listBalances(query: ListFinishedGoodsBalancesQuery): Promise<{
    items: FinishedGoodsBalanceListItem[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const offset = query.offset ?? 0;
    const where = buildBalanceWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.finishedGoodsBalance.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
        include: BALANCE_LIST_INCLUDE,
      }),
      this.prisma.finishedGoodsBalance.count({ where }),
    ]);

    return {
      items: rows.map(toBalanceListItem),
      total,
      limit,
      offset,
    };
  }

  async listMovements(query: ListFinishedGoodsMovementsQuery): Promise<{
    items: FinishedGoodsMovementListItem[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const offset = query.offset ?? 0;
    const where = buildMovementWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.finishedGoodsMovement.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
        include: MOVEMENT_LIST_INCLUDE,
      }),
      this.prisma.finishedGoodsMovement.count({ where }),
    ]);

    return {
      items: rows.map(toMovementListItem),
      total,
      limit,
      offset,
    };
  }

  // ===========================================================================
  // INTERNAL CORE
  // ===========================================================================

  /**
   * Найти / создать `FinishedGoodsBalance` по детерминированному ключу.
   *
   * Аналог `StockService.getOrCreateBalanceInTx` для готовой продукции.
   * Безопасен относительно гонок: при конкурентной вставке ловит
   * `P2002` и возвращает существующую строку.
   */
  async getOrCreateBalanceInTx(
    tx: Prisma.TransactionClient,
    params: GetOrCreateFinishedGoodsBalanceParams,
  ): Promise<FinishedGoodsBalance> {
    const balanceKey = buildFinishedGoodsBalanceKey(params);
    const existing = await tx.finishedGoodsBalance.findUnique({
      where: { balanceKey },
    });
    if (existing) return existing;
    try {
      return await tx.finishedGoodsBalance.create({
        data: {
          balanceKey,
          orderId: params.orderId,
          productId: params.productId,
          sizeId: params.sizeId,
          color: params.color,
          warehouseId: params.warehouseId ?? null,
          cellId: params.cellId ?? null,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return tx.finishedGoodsBalance.findUniqueOrThrow({
          where: { balanceKey },
        });
      }
      throw err;
    }
  }

  /**
   * Применить движение готовой продукции и обновить баланс.
   *
   * Контракт:
   *   - `qty > 0`, `direction ∈ {IN, OUT}`;
   *   - `IN`: `balanceAfterQty = before + qty`;
   *   - `OUT`: `balanceAfterQty = before - qty` (на MVP не используется);
   *   - `sourceKey` идемпотентен: если движение с таким ключом уже
   *     существует, сервис возвращает его и НЕ меняет баланс повторно.
   *
   * Все операции — в переданной транзакции, новую `$transaction` НЕ
   * открывает.
   */
  async applyMovementInTx(
    tx: Prisma.TransactionClient,
    params: ApplyFinishedGoodsMovementParams,
  ): Promise<{
    movement: FinishedGoodsMovement;
    balance: FinishedGoodsBalance;
    /** `true`, если движение уже существовало и баланс не менялся. */
    idempotent: boolean;
  }> {
    if (!Number.isInteger(params.qty) || params.qty <= 0) {
      throw new BusinessException(
        'FINISHED_GOODS_MOVEMENT_QTY_INVALID',
        'Количество движения готовой продукции должно быть целым положительным числом.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      params.direction !== FINISHED_GOODS_MOVEMENT_DIRECTION.IN &&
      params.direction !== FINISHED_GOODS_MOVEMENT_DIRECTION.OUT
    ) {
      throw new BusinessException(
        'FINISHED_GOODS_MOVEMENT_DIRECTION_INVALID',
        'Недопустимое направление движения готовой продукции (ожидается IN или OUT).',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Идемпотентность по sourceKey: если движение уже есть, возвращаем
    // его и баланс не апдейтим повторно.
    if (params.sourceKey) {
      const existing = await tx.finishedGoodsMovement.findUnique({
        where: { sourceKey: params.sourceKey },
      });
      if (existing) {
        const balance = existing.finishedGoodsBalanceId
          ? await tx.finishedGoodsBalance.findUnique({
              where: { id: existing.finishedGoodsBalanceId },
            })
          : await this.getOrCreateBalanceInTx(tx, {
              orderId: params.orderId,
              productId: params.productId,
              sizeId: params.sizeId,
              color: params.color,
              warehouseId: params.warehouseId,
              cellId: params.cellId,
            });
        return {
          movement: existing,
          balance: balance ?? (await this.getOrCreateBalanceInTx(tx, params)),
          idempotent: true,
        };
      }
    }

    const balance = await this.getOrCreateBalanceInTx(tx, {
      orderId: params.orderId,
      productId: params.productId,
      sizeId: params.sizeId,
      color: params.color,
      warehouseId: params.warehouseId,
      cellId: params.cellId,
    });

    const isIn = params.direction === FINISHED_GOODS_MOVEMENT_DIRECTION.IN;
    const balanceBeforeQty = balance.qty;
    const balanceAfterQty = isIn
      ? balanceBeforeQty + params.qty
      : balanceBeforeQty - params.qty;

    const movement = await tx.finishedGoodsMovement.create({
      data: {
        finishedGoodsBalanceId: balance.id,
        type: params.type,
        direction: params.direction,
        orderId: params.orderId,
        productId: params.productId,
        sizeId: params.sizeId,
        color: params.color,
        warehouseId: params.warehouseId ?? null,
        cellId: params.cellId ?? null,
        qty: params.qty,
        balanceBeforeQty,
        balanceAfterQty,
        sourceType: params.sourceType ?? null,
        sourceId: params.sourceId ?? null,
        sourceKey: params.sourceKey ?? null,
        passportId: params.passportId ?? null,
        boxId: params.boxId ?? null,
        comment: params.comment ?? null,
        createdById: params.createdById ?? null,
      },
    });

    const updated = await tx.finishedGoodsBalance.update({
      where: { id: balance.id },
      data: {
        qty: balanceAfterQty,
        lastMovementAt: new Date(),
      },
    });

    return { movement, balance: updated, idempotent: false };
  }

  // ===========================================================================
  // PACKED PASSPORT → PRODUCTION_RECEIPT IN
  // ===========================================================================

  /**
   * Зафиксировать выпуск готовой продукции в момент `Passport.status = PACKED`.
   *
   * Контракт:
   *   - вызывается из `PackingService.addPassport` строго **внутри**
   *     той же `$transaction(...)`, что и сам перевод паспорта в
   *     `PACKED`;
   *   - идемпотентен по `sourceKey = PACKED_PASSPORT:<passportId>`:
   *     повторный вызов (retry, дубль box-close handler) не задвоит
   *     движение и не удвоит баланс;
   *   - `qty = passport.qtyGood` (количество годных в этом паспорте);
   *     если `qty <= 0`, soft-skip без ошибки и без записи;
   *   - `warehouseId = order.finishedGoodsWarehouseId` (может быть
   *     `null` — тогда ведём «no-warehouse» баланс, упаковку это не
   *     блокирует);
   *   - `cellId = null` на этой итерации;
   *   - audit `FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED` пишется в
   *     той же транзакции (см. `AuditEntityType = FINISHED_GOODS_MOVEMENT`).
   *
   * Возвращает созданное (или ранее существовавшее) движение, либо
   * `null`, если движение не понадобилось (qty <= 0 или паспорт не
   * найден / не в PACKED).
   */
  async recordPackedPassportInTx(
    tx: Prisma.TransactionClient,
    passportId: string,
    employeeId?: string | null,
    boxIdHint?: string | null,
  ): Promise<FinishedGoodsMovement | null> {
    const passport = await tx.passport.findUnique({
      where: { id: passportId },
      select: {
        id: true,
        status: true,
        qtyGood: true,
        productId: true,
        sizeId: true,
        color: true,
        orderId: true,
        order: {
          select: {
            id: true,
            finishedGoodsWarehouseId: true,
          },
        },
      },
    });

    if (!passport) return null;
    if (passport.status !== PassportStatus.PACKED) return null;
    if (passport.qtyGood <= 0) return null;

    const sourceKey = buildPackedPassportSourceKey(passport.id);
    const warehouseId = passport.order.finishedGoodsWarehouseId ?? null;

    // Если boxIdHint не передан, попробуем найти box через BoxItem
    // (внутри той же транзакции).
    let boxId = boxIdHint ?? null;
    if (!boxId) {
      const boxItem = await tx.boxItem.findUnique({
        where: { passportId: passport.id },
        select: { boxId: true },
      });
      boxId = boxItem?.boxId ?? null;
    }

    const { movement, balance, idempotent } = await this.applyMovementInTx(tx, {
      orderId: passport.orderId,
      productId: passport.productId,
      sizeId: passport.sizeId,
      color: passport.color,
      warehouseId,
      cellId: null,
      type: FINISHED_GOODS_MOVEMENT_TYPE.PRODUCTION_RECEIPT,
      direction: FINISHED_GOODS_MOVEMENT_DIRECTION.IN,
      qty: passport.qtyGood,
      sourceType: FINISHED_GOODS_SOURCE_TYPE.PACKED_PASSPORT,
      sourceId: passport.id,
      sourceKey,
      passportId: passport.id,
      boxId,
      comment: 'Выпуск готовой продукции после упаковки',
      createdById: employeeId ?? null,
    });

    if (idempotent) return movement;

    await this.audit.log(
      {
        event: 'FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED',
        entityType: 'FINISHED_GOODS_MOVEMENT',
        entityId: movement.id,
        employeeId: employeeId ?? null,
        payload: {
          finishedGoodsMovementId: movement.id,
          finishedGoodsBalanceId: balance.id,
          orderId: passport.orderId,
          passportId: passport.id,
          boxId,
          productId: passport.productId,
          sizeId: passport.sizeId,
          color: passport.color,
          warehouseId,
          cellId: null,
          qty: movement.qty,
          balanceBeforeQty: movement.balanceBeforeQty,
          balanceAfterQty: movement.balanceAfterQty,
          employeeId: employeeId ?? null,
          timestamp: movement.createdAt.toISOString(),
        } as Prisma.InputJsonValue,
      },
      tx,
    );

    this.logger.log(
      `event=finished_goods.production_receipt.create movementId=${movement.id} ` +
        `passportId=${passport.id} orderId=${passport.orderId} qty=${movement.qty} ` +
        `warehouseId=${warehouseId ?? 'NO_WAREHOUSE'}`,
    );

    return movement;
  }
}

// ---------------------------------------------------------------------------
// helpers (file-private)
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;

const BALANCE_LIST_INCLUDE = {
  order: { select: { id: true, number: true } },
  product: { select: { id: true, name: true } },
  size: { select: { id: true, code: true } },
  warehouse: { select: { id: true, name: true, code: true } },
  cell: { select: { id: true, code: true } },
} as const satisfies Prisma.FinishedGoodsBalanceInclude;

const MOVEMENT_LIST_INCLUDE = {
  order: { select: { id: true, number: true } },
  product: { select: { id: true, name: true } },
  size: { select: { id: true, code: true } },
  warehouse: { select: { id: true, name: true, code: true } },
  cell: { select: { id: true, code: true } },
} as const satisfies Prisma.FinishedGoodsMovementInclude;

type BalanceWithRels = Prisma.FinishedGoodsBalanceGetPayload<{
  include: typeof BALANCE_LIST_INCLUDE;
}>;

type MovementWithRels = Prisma.FinishedGoodsMovementGetPayload<{
  include: typeof MOVEMENT_LIST_INCLUDE;
}>;

export interface FinishedGoodsBalanceListItem {
  id: string;
  balanceKey: string;
  orderId: string;
  orderNumber: string | null;
  productId: string;
  productName: string | null;
  sizeId: string;
  sizeCode: string | null;
  color: string;
  warehouseId: string | null;
  warehouseName: string | null;
  cellId: string | null;
  cellCode: string | null;
  qty: number;
  lastMovementAt: string | null;
  updatedAt: string;
}

export interface FinishedGoodsMovementListItem {
  id: string;
  finishedGoodsBalanceId: string | null;
  type: string;
  direction: string;
  orderId: string;
  orderNumber: string | null;
  productId: string;
  productName: string | null;
  sizeId: string;
  sizeCode: string | null;
  color: string;
  warehouseId: string | null;
  warehouseName: string | null;
  cellId: string | null;
  cellCode: string | null;
  qty: number;
  balanceBeforeQty: number | null;
  balanceAfterQty: number | null;
  sourceType: string | null;
  sourceId: string | null;
  passportId: string | null;
  boxId: string | null;
  comment: string | null;
  createdById: string | null;
  createdAt: string;
  // sourceKey намеренно не возвращается — это внутренний идемпотентный
  // технический ключ (PACKED_PASSPORT:<passportId>).
}

function buildBalanceWhere(
  query: ListFinishedGoodsBalancesQuery,
): Prisma.FinishedGoodsBalanceWhereInput {
  const conditions: Prisma.FinishedGoodsBalanceWhereInput[] = [];

  if (query.orderId) conditions.push({ orderId: query.orderId });
  if (query.productId) conditions.push({ productId: query.productId });
  if (query.sizeId) conditions.push({ sizeId: query.sizeId });
  if (query.warehouseId) conditions.push({ warehouseId: query.warehouseId });
  if (query.cellId) conditions.push({ cellId: query.cellId });
  if (query.q) {
    conditions.push({ color: { contains: query.q, mode: 'insensitive' } });
  }
  if (query.positiveOnly) conditions.push({ qty: { gt: 0 } });
  if (query.negativeOnly) conditions.push({ qty: { lt: 0 } });
  if (query.zeroOnly) conditions.push({ qty: 0 });

  return conditions.length === 0 ? {} : { AND: conditions };
}

function buildMovementWhere(
  query: ListFinishedGoodsMovementsQuery,
): Prisma.FinishedGoodsMovementWhereInput {
  const conditions: Prisma.FinishedGoodsMovementWhereInput[] = [];

  if (query.orderId) conditions.push({ orderId: query.orderId });
  if (query.productId) conditions.push({ productId: query.productId });
  if (query.sizeId) conditions.push({ sizeId: query.sizeId });
  if (query.warehouseId) conditions.push({ warehouseId: query.warehouseId });
  if (query.cellId) conditions.push({ cellId: query.cellId });
  if (query.type) conditions.push({ type: query.type });
  if (query.direction) conditions.push({ direction: query.direction });
  if (query.passportId) conditions.push({ passportId: query.passportId });
  if (query.boxId) conditions.push({ boxId: query.boxId });
  if (query.from || query.to) {
    const range: Prisma.DateTimeFilter = {};
    if (query.from) range.gte = new Date(query.from);
    if (query.to) range.lte = new Date(query.to);
    conditions.push({ createdAt: range });
  }

  return conditions.length === 0 ? {} : { AND: conditions };
}

function toBalanceListItem(row: BalanceWithRels): FinishedGoodsBalanceListItem {
  return {
    id: row.id,
    balanceKey: row.balanceKey,
    orderId: row.orderId,
    orderNumber: row.order?.number ?? null,
    productId: row.productId,
    productName: row.product?.name ?? null,
    sizeId: row.sizeId,
    sizeCode: row.size?.code ?? null,
    color: row.color,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouse?.name ?? null,
    cellId: row.cellId,
    cellCode: row.cell?.code ?? null,
    qty: row.qty,
    lastMovementAt: row.lastMovementAt
      ? row.lastMovementAt.toISOString()
      : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMovementListItem(
  row: MovementWithRels,
): FinishedGoodsMovementListItem {
  return {
    id: row.id,
    finishedGoodsBalanceId: row.finishedGoodsBalanceId,
    type: row.type,
    direction: row.direction,
    orderId: row.orderId,
    orderNumber: row.order?.number ?? null,
    productId: row.productId,
    productName: row.product?.name ?? null,
    sizeId: row.sizeId,
    sizeCode: row.size?.code ?? null,
    color: row.color,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouse?.name ?? null,
    cellId: row.cellId,
    cellCode: row.cell?.code ?? null,
    qty: row.qty,
    balanceBeforeQty: row.balanceBeforeQty,
    balanceAfterQty: row.balanceAfterQty,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    passportId: row.passportId,
    boxId: row.boxId,
    comment: row.comment,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
  };
}
