import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  PassportStatus,
  type FinishedGoodsBalance,
  type FinishedGoodsMovement,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { normalizeColor } from '@sewing/shared/colors';

import { BusinessException } from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { CancelFinishedGoodsShipmentDto } from './dto/cancel-finished-goods-shipment.dto.js';
import type { CreateFinishedGoodsAdjustmentDto } from './dto/create-finished-goods-adjustment.dto.js';
import type { CreateFinishedGoodsShipmentDto } from './dto/create-finished-goods-shipment.dto.js';
import type { CreateFinishedGoodsTransferDto } from './dto/create-finished-goods-transfer.dto.js';
import type { ListFinishedGoodsBalancesQuery } from './dto/list-finished-goods-balances.dto.js';
import type { ListFinishedGoodsMovementsQuery } from './dto/list-finished-goods-movements.dto.js';
import { FinishedGoodsShipmentNumberService } from './finished-goods-shipment-number.service.js';
import {
  FINISHED_GOODS_MOVEMENT_DIRECTION,
  FINISHED_GOODS_MOVEMENT_TYPE,
  FINISHED_GOODS_SOURCE_TYPE,
  buildFinishedGoodsAdjustmentSourceKey,
  buildFinishedGoodsBalanceKey,
  buildFinishedGoodsShipmentCancelLineSourceKey,
  buildFinishedGoodsShipmentLineSourceKey,
  buildFinishedGoodsShipmentSourceKey,
  buildFinishedGoodsTransferInSourceKey,
  buildFinishedGoodsTransferOutSourceKey,
  buildPassportFinishedGoodsOutputSourceKey,
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
    private readonly shipmentNumber: FinishedGoodsShipmentNumberService,
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

    // Готовая продукция в MVP не уходит в минус — отгрузка не может
    // увести остаток ниже нуля. `allowNegativeMaterialStock` к этому
    // контуру неприменим (это флаг для StockBalance материалов).
    if (!isIn && balanceAfterQty < 0) {
      throw new BusinessException(
        'FINISHED_GOODS_INSUFFICIENT_BALANCE',
        `Недостаточно остатка готовой продукции: доступно ${balanceBeforeQty}, требуется ${params.qty}.`,
        HttpStatus.CONFLICT,
      );
    }

    const movement = await tx.finishedGoodsMovement.create({
      data: {
        finishedGoodsBalanceId: balance.id,
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
  // PASSPORT OUTPUT → PRODUCTION_RECEIPT IN
  // ===========================================================================

  /**
   * Зафиксировать выпуск готовой продукции по паспорту.
   *
   * Единая точка записи `FinishedGoodsMovement PRODUCTION_RECEIPT IN`
   * для двух триггеров (см. `docs/current-state.md §«Готовая
   * продукция»`):
   *   1. Прохождение операции с `Operation.producesFinishedGoods = true`
   *      — вызывается из `PassportsService.scanOnOperation` /
   *      `PassportsService.completeOperationByEmployee` в той же
   *      транзакции, что и обновление паспорта;
   *   2. `Passport.status = PACKED` — вызывается из
   *      `PackingService.addPassport` (через
   *      `recordPackedPassportInTx`-обёртку, оставленную для обратной
   *      совместимости).
   *
   * Контракт:
   *   - идемпотентен по `sourceKey = PACKED_PASSPORT:<passportId>`
   *     (см. `buildPassportFinishedGoodsOutputSourceKey` —
   *     сознательно совпадает с `buildPackedPassportSourceKey`):
   *     повторный complete/scan и последующая упаковка не задвоят
   *     движение и не удвоят `FinishedGoodsBalance.qty`;
   *   - `qty = passport.qtyGood`; если `qty <= 0` — soft-skip;
   *   - `warehouseId = order.finishedGoodsWarehouseId` (может быть
   *     `null` — ведём «no-warehouse» баланс, поток не блокируем);
   *   - `cellId = null` на этой итерации;
   *   - audit `FINISHED_GOODS_PRODUCTION_RECEIPT_CREATED` пишется в
   *     той же транзакции (только при первом, не идемпотентном вызове).
   *
   * Возвращает созданное (или ранее существовавшее) движение, либо
   * `null`, если движение не понадобилось (паспорт отменён, qty <= 0).
   *
   * Не путать с материалами (`StockMovement` / `MaterialIssue` /
   * `PurchaseReceipt` / `StockAdjustment` / `StockTransfer`) и
   * с `CostsService` / `ProductionCostV2Service` — это отдельный
   * контур (см. JSDoc сервиса).
   */
  async recordPassportOutputInTx(
    tx: Prisma.TransactionClient,
    passportId: string,
    employeeId?: string | null,
    options?: {
      boxIdHint?: string | null;
      /**
       * Метаданные для лога/audit о причине вызова. Не влияет на
       * сам факт выпуска — выпуск всегда один на паспорт благодаря
       * `sourceKey`-идемпотентности.
       */
      trigger?: 'OPERATION_OUTPUT' | 'PACKED_PASSPORT';
      triggerOperationId?: string | null;
      comment?: string | null;
    },
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
    if (passport.status === PassportStatus.CANCELLED) return null;
    if (passport.qtyGood <= 0) return null;

    const sourceKey = buildPassportFinishedGoodsOutputSourceKey(passport.id);
    const warehouseId = passport.order.finishedGoodsWarehouseId ?? null;
    const trigger = options?.trigger ?? 'PACKED_PASSPORT';

    // Если boxIdHint не передан, попробуем найти box через BoxItem
    // (внутри той же транзакции). Для operation-driven выпуска коробки
    // ещё может не быть — это нормально, оставим `null`.
    let boxId = options?.boxIdHint ?? null;
    if (!boxId) {
      const boxItem = await tx.boxItem.findUnique({
        where: { passportId: passport.id },
        select: { boxId: true },
      });
      boxId = boxItem?.boxId ?? null;
    }

    const comment =
      options?.comment ??
      (trigger === 'OPERATION_OUTPUT'
        ? 'Выпуск готовой продукции по операции'
        : 'Выпуск готовой продукции после упаковки');

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
      comment,
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
          trigger,
          triggerOperationId: options?.triggerOperationId ?? null,
          timestamp: movement.createdAt.toISOString(),
        } as Prisma.InputJsonValue,
      },
      tx,
    );

    this.logger.log(
      `event=finished_goods.production_receipt.create movementId=${movement.id} ` +
        `passportId=${passport.id} orderId=${passport.orderId} qty=${movement.qty} ` +
        `warehouseId=${warehouseId ?? 'NO_WAREHOUSE'} trigger=${trigger}` +
        (options?.triggerOperationId
          ? ` operationId=${options.triggerOperationId}`
          : ''),
    );

    return movement;
  }

  /**
   * Wrapper над `recordPassportOutputInTx` для исторического
   * packing-flow (`PackingService.addPassport`), сохранённый для
   * обратной совместимости и явной читаемости вызова. Дополнительно
   * требует `Passport.status = PACKED` — иначе soft-skip.
   *
   * Идемпотентен по `sourceKey = PACKED_PASSPORT:<passportId>`,
   * совпадает с operation-driven выпуском — двойной триггер
   * (operation flag + последующий PACKED) выпуск не задваивает.
   */
  async recordPackedPassportInTx(
    tx: Prisma.TransactionClient,
    passportId: string,
    employeeId?: string | null,
    boxIdHint?: string | null,
  ): Promise<FinishedGoodsMovement | null> {
    const passport = await tx.passport.findUnique({
      where: { id: passportId },
      select: { id: true, status: true },
    });
    if (!passport) return null;
    if (passport.status !== PassportStatus.PACKED) return null;

    return this.recordPassportOutputInTx(tx, passportId, employeeId, {
      boxIdHint: boxIdHint ?? null,
      trigger: 'PACKED_PASSPORT',
    });
  }

  // ===========================================================================
  // SHIPMENT — отгрузка готовой продукции из карточки заказа
  // ===========================================================================

  /**
   * Список документов отгрузки готовой продукции по заказу.
   *
   * Read-only, отдаёт detail-shape (заголовок + строки + lookups).
   * Сортировка `shippedAt desc, createdAt desc, id desc`. RBAC и
   * проверка существования заказа выполняется на уровне контроллера
   * (`ADMIN` / `SHOP_MANAGER`).
   */
  async listShipmentsByOrder(
    orderId: string,
  ): Promise<FinishedGoodsShipmentDetailDto[]> {
    const rows = await this.prisma.finishedGoodsShipment.findMany({
      where: { orderId },
      orderBy: [{ shippedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      include: SHIPMENT_DETAIL_INCLUDE,
    });
    return rows.map(toShipmentDetailDto);
  }

  async getShipmentDetail(
    id: string,
  ): Promise<FinishedGoodsShipmentDetailDto> {
    const row = await this.prisma.finishedGoodsShipment.findUnique({
      where: { id },
      include: SHIPMENT_DETAIL_INCLUDE,
    });
    if (!row) {
      throw new BusinessException(
        'FINISHED_GOODS_SHIPMENT_NOT_FOUND',
        'Документ отгрузки готовой продукции не найден.',
        HttpStatus.NOT_FOUND,
      );
    }
    return toShipmentDetailDto(row);
  }

  /**
   * Создать документ отгрузки готовой продукции по заказу.
   *
   * Контракт (см. `docs/api.md §«Finished goods shipments»`):
   *   - открывает `prisma.$transaction`, внутри:
   *     1. валидирует, что заказ существует;
   *     2. отбрасывает `qty <= 0` строки и проверяет, что все
   *        `finishedGoodsBalanceId` уникальны — duplicate в request
   *        отклоняется (`FINISHED_GOODS_SHIPMENT_DUPLICATE_BALANCE`);
   *     3. строит `sourceKey` по `clientRequestId` (если не передан —
   *        генерирует UUID server-side; повторный submit под новым
   *        ключом не идемпотентен);
   *     4. если документ с этим `sourceKey` уже существует — отдаёт
   *        существующий detail (никаких новых движений / списаний);
   *     5. для каждой строки находит `FinishedGoodsBalance`,
   *        проверяет принадлежность заказу (`balance.orderId === orderId`)
   *        и достаточность остатка (`balance.qty >= qty`);
   *     6. создаёт `FinishedGoodsShipment` `status = POSTED` +
   *        `FinishedGoodsShipmentLine` snapshot;
   *     7. для каждой строки создаёт `FinishedGoodsMovement`
   *        `type = SHIPMENT, direction = OUT` через
   *        `applyMovementInTx` — c sourceKey
   *        `FINISHED_GOODS_SHIPMENT_LINE:<lineId>`. Балансы
   *        атомарно уменьшаются;
   *     8. пишет audit `FINISHED_GOODS_SHIPMENT_CREATED`
   *        (`entityType = FINISHED_GOODS_SHIPMENT`).
   *
   * **Не меняет** `Order.status` автоматически — это сознательное
   * решение, см. ТЗ. Не затрагивает материалы (`StockBalance` /
   * `StockMovement` / `MaterialIssue` / `PurchaseReceipt` /
   * `StockAdjustment` / `StockTransfer` / `CostsService` /
   * `ProductionCostV2Service`).
   */
  /**
   * ⛔ ГАРД §0.5: ручные движения остатка готовой продукции закрыты, когда его ведёт ERP.
   *
   * «Выпуск готовой продукции швейного цеха приходуется на склад ERP. Собственных складов —
   * материалов, готовой продукции, полок — у цеха нет» (правило владельца §0.5,
   * `service/docs/kb/sewing.md`). Пока флаг снят — всё работает как раньше; поднятый флаг
   * означает, что перемещать, корректировать и отгружать готовую продукцию можно только в ERP,
   * иначе у одной футболки снова два остатка и два хозяина.
   *
   * Журнал выпуска (`PRODUCTION_RECEIPT` при упаковке) под гард НЕ попадает: он не склад, а
   * след того, что цех сделал, и его читают доска, дашборд и себестоимость.
   */
  private async assertErpDoesNotOwnFinishedGoods(action: string): Promise<void> {
    const settings = await this.prisma.companySettings.findUnique({
      where: { id: 'default' },
      select: { erpOwnsFinishedGoods: true },
    });
    if (!settings?.erpOwnsFinishedGoods) return;
    throw new BusinessException(
      'FINISHED_GOODS_OWNED_BY_ERP',
      `Остаток готовой продукции ведёт ERP — ${action} выполняется в ней`,
      HttpStatus.CONFLICT,
    );
  }

  async createShipmentForOrder(
    orderId: string,
    dto: CreateFinishedGoodsShipmentDto,
    employeeId?: string | null,
  ): Promise<FinishedGoodsShipmentDetailDto> {
    await this.assertErpDoesNotOwnFinishedGoods('отгрузка');
    // Базовая нормализация и проверки заказа выполняются вне
    // транзакции — это не меняет состояние.
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) {
      throw new BusinessException(
        'ORDER_NOT_FOUND',
        `Заказ ${orderId} не найден.`,
        HttpStatus.NOT_FOUND,
      );
    }

    // Duplicate finishedGoodsBalanceId в request — запрещаем (одна
    // строка на баланс). Это безопаснее агрегации: менеджер видит
    // ровно те строки, которые он ввёл.
    const seenBalances = new Set<string>();
    for (const line of dto.lines) {
      if (seenBalances.has(line.finishedGoodsBalanceId)) {
        throw new BusinessException(
          'FINISHED_GOODS_SHIPMENT_DUPLICATE_BALANCE',
          'В заявке на отгрузку строки по одному остатку готовой продукции дублируются.',
          HttpStatus.BAD_REQUEST,
        );
      }
      seenBalances.add(line.finishedGoodsBalanceId);
    }

    const clientRequestId = dto.clientRequestId ?? randomUUID();
    const sourceKey = buildFinishedGoodsShipmentSourceKey(
      orderId,
      clientRequestId,
    );

    // Idempotency: если shipment с таким sourceKey уже создан —
    // возвращаем existing detail без апдейта балансов.
    const existing = await this.prisma.finishedGoodsShipment.findUnique({
      where: { sourceKey },
      include: SHIPMENT_DETAIL_INCLUDE,
    });
    if (existing) {
      return toShipmentDetailDto(existing);
    }

    const shippedAt = dto.shippedAt ? new Date(dto.shippedAt) : new Date();

    const detail = await this.prisma.$transaction(async (tx) => {
      // Подгружаем все балансы одним запросом и валидируем.
      const balances = await tx.finishedGoodsBalance.findMany({
        where: { id: { in: dto.lines.map((l) => l.finishedGoodsBalanceId) } },
      });
      const balancesById = new Map(balances.map((b) => [b.id, b]));
      for (const line of dto.lines) {
        const balance = balancesById.get(line.finishedGoodsBalanceId);
        if (!balance) {
          throw new BusinessException(
            'FINISHED_GOODS_BALANCE_NOT_FOUND',
            `Остаток готовой продукции ${line.finishedGoodsBalanceId} не найден.`,
            HttpStatus.NOT_FOUND,
          );
        }
        if (balance.orderId !== orderId) {
          throw new BusinessException(
            'FINISHED_GOODS_SHIPMENT_BALANCE_ORDER_MISMATCH',
            'Остаток готовой продукции принадлежит другому заказу.',
            HttpStatus.BAD_REQUEST,
          );
        }
        if (balance.qty < line.qty) {
          throw new BusinessException(
            'FINISHED_GOODS_SHIPMENT_QTY_EXCEEDS_AVAILABLE',
            `Нельзя отгрузить ${line.qty} шт.: на остатке доступно ${balance.qty}.`,
            HttpStatus.CONFLICT,
          );
        }
      }

      const number = await this.shipmentNumber.nextNumber(tx, shippedAt);

      const shipment = await tx.finishedGoodsShipment.create({
        data: {
          number,
          orderId,
          status: 'POSTED',
          shippedAt,
          comment: dto.comment ?? null,
          sourceKey,
          createdById: employeeId ?? null,
        },
      });

      // Создаём строки и attached SHIPMENT OUT движения. Каждое
      // movement идёт через `applyMovementInTx` — баланс уменьшается
      // атомарно, и при `balance.qty < qty` после конкурентной
      // отгрузки бросится `FINISHED_GOODS_INSUFFICIENT_BALANCE` (409),
      // которое откатит всю транзакцию.
      const movements: FinishedGoodsMovement[] = [];
      const lineIds: string[] = [];
      for (const line of dto.lines) {
        const balance = balancesById.get(line.finishedGoodsBalanceId)!;
        const shipmentLine = await tx.finishedGoodsShipmentLine.create({
          data: {
            finishedGoodsShipmentId: shipment.id,
            finishedGoodsBalanceId: balance.id,
            orderId,
            productId: balance.productId,
            sizeId: balance.sizeId,
            color: balance.color,
            warehouseId: balance.warehouseId,
            cellId: balance.cellId,
            qty: line.qty,
            comment: line.comment ?? null,
          },
        });
        lineIds.push(shipmentLine.id);

        const { movement } = await this.applyMovementInTx(tx, {
          orderId,
          productId: balance.productId,
          sizeId: balance.sizeId,
          color: balance.color,
          warehouseId: balance.warehouseId,
          cellId: balance.cellId,
          type: FINISHED_GOODS_MOVEMENT_TYPE.SHIPMENT,
          direction: FINISHED_GOODS_MOVEMENT_DIRECTION.OUT,
          qty: line.qty,
          sourceType: FINISHED_GOODS_SOURCE_TYPE.FINISHED_GOODS_SHIPMENT_LINE,
          sourceId: shipmentLine.id,
          sourceKey: buildFinishedGoodsShipmentLineSourceKey(shipmentLine.id),
          comment: dto.comment ?? 'Отгрузка готовой продукции',
          createdById: employeeId ?? null,
        });
        movements.push(movement);
      }

      // Audit пишется в той же транзакции — либо документ + движения +
      // запись в журнале атомарно, либо ничего.
      await this.audit.log(
        {
          event: 'FINISHED_GOODS_SHIPMENT_CREATED',
          entityType: 'FINISHED_GOODS_SHIPMENT',
          entityId: shipment.id,
          employeeId: employeeId ?? null,
          payload: {
            finishedGoodsShipmentId: shipment.id,
            number: shipment.number,
            orderId,
            shippedAt: shipment.shippedAt.toISOString(),
            comment: shipment.comment,
            lines: dto.lines.map((line, idx) => ({
              finishedGoodsShipmentLineId: lineIds[idx],
              finishedGoodsBalanceId: line.finishedGoodsBalanceId,
              productId: balancesById.get(line.finishedGoodsBalanceId)!
                .productId,
              sizeId: balancesById.get(line.finishedGoodsBalanceId)!.sizeId,
              color: balancesById.get(line.finishedGoodsBalanceId)!.color,
              warehouseId: balancesById.get(line.finishedGoodsBalanceId)!
                .warehouseId,
              cellId: balancesById.get(line.finishedGoodsBalanceId)!.cellId,
              qty: line.qty,
            })),
            employeeId: employeeId ?? null,
            timestamp: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
        tx,
      );

      this.logger.log(
        `event=finished_goods.shipment.create shipmentId=${shipment.id} ` +
          `number=${shipment.number} orderId=${orderId} ` +
          `lines=${dto.lines.length} totalQty=${dto.lines.reduce(
            (acc, l) => acc + l.qty,
            0,
          )}`,
      );

      const reloaded = await tx.finishedGoodsShipment.findUniqueOrThrow({
        where: { id: shipment.id },
        include: SHIPMENT_DETAIL_INCLUDE,
      });
      return reloaded;
    });

    return toShipmentDetailDto(detail);
  }

  /**
   * Отмена документа отгрузки целиком (см. `docs/api.md §«Finished
   * goods shipments»`, ТЗ итерации «Отмена / сторно отгрузки»).
   *
   * Решение владельца проекта — НЕ создавать отдельную модель
   * `FinishedGoodsShipmentReturn` / `FinishedGoodsShipmentCancel`.
   * Существующий документ `FinishedGoodsShipment` получает
   * `status = CANCELLED` + `cancelledAt` / `cancelledById` /
   * `cancelReason`; по каждой строке создаётся обратное
   * `FinishedGoodsMovement` `type = REVERSAL, direction = IN`
   * (sourceKey `FINISHED_GOODS_SHIPMENT_CANCEL_LINE:<lineId>`).
   * Балансы атомарно увеличиваются обратно через `applyMovementInTx`.
   *
   * Контракт:
   *   - `404` если документа нет;
   *   - **idempotent** при повторном вызове на уже отменённом
   *     документе: возвращаем existing detail, новые движения НЕ
   *     создаём (защита и на уровне shipment.status, и через
   *     `sourceKey @unique` movement-а);
   *   - `409 FINISHED_GOODS_SHIPMENT_INVALID_STATUS` если статус
   *     неизвестный (на MVP допустимы только POSTED / CANCELLED, но
   *     поле `status` свободная строка — защищаемся явно);
   *   - **частичная отмена не поддерживается** — отменяется весь
   *     документ. Если нужно отгрузить меньше, пользователь отменяет
   *     ошибочный shipment целиком и создаёт новый корректный.
   *
   * Audit `FINISHED_GOODS_SHIPMENT_CANCELLED` пишется в той же
   * транзакции, что и сам документ + N REVERSAL IN. **Order.status
   * автоматически НЕ меняется.** Material `StockBalance` /
   * `StockMovement` / `MaterialIssue` не затрагиваются.
   */
  async cancelShipment(
    id: string,
    dto: CancelFinishedGoodsShipmentDto,
    employeeId?: string | null,
  ): Promise<FinishedGoodsShipmentDetailDto> {
    await this.assertErpDoesNotOwnFinishedGoods('отмена отгрузки');
    const shipment = await this.prisma.finishedGoodsShipment.findUnique({
      where: { id },
      include: SHIPMENT_DETAIL_INCLUDE,
    });
    if (!shipment) {
      throw new BusinessException(
        'FINISHED_GOODS_SHIPMENT_NOT_FOUND',
        'Документ отгрузки готовой продукции не найден.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Idempotent re-cancel: возвращаем existing detail, не пишем
    // новые движения и не повторяем audit. UNIQUE на
    // `FinishedGoodsMovement.sourceKey` всё равно подстрахует от
    // дубликатов на race-condition.
    if (shipment.status === 'CANCELLED') {
      return toShipmentDetailDto(shipment);
    }
    if (shipment.status !== 'POSTED') {
      throw new BusinessException(
        'FINISHED_GOODS_SHIPMENT_INVALID_STATUS',
        `Нельзя отменить документ отгрузки в статусе ${shipment.status}. Ожидался POSTED.`,
        HttpStatus.CONFLICT,
      );
    }

    const cancelledAt = new Date();
    const reason = dto.reason;

    const detail = await this.prisma.$transaction(async (tx) => {
      // 1. Помечаем документ как отменённый.
      await tx.finishedGoodsShipment.update({
        where: { id: shipment.id },
        data: {
          status: 'CANCELLED',
          cancelledAt,
          cancelledById: employeeId ?? null,
          cancelReason: reason,
        },
      });

      // 2. Для каждой строки — обратное движение REVERSAL IN.
      // Идемпотентность по `sourceKey @unique`: повторный вызов
      // (race / retry внутри транзакции) на ту же строку вернёт
      // существующее движение и баланс повторно не апдейтит — это
      // ровно поведение `applyMovementInTx`.
      for (const line of shipment.lines) {
        await this.applyMovementInTx(tx, {
          orderId: line.orderId,
          productId: line.productId,
          sizeId: line.sizeId,
          color: line.color,
          warehouseId: line.warehouseId,
          cellId: line.cellId,
          type: FINISHED_GOODS_MOVEMENT_TYPE.REVERSAL,
          direction: FINISHED_GOODS_MOVEMENT_DIRECTION.IN,
          qty: line.qty,
          sourceType:
            FINISHED_GOODS_SOURCE_TYPE.FINISHED_GOODS_SHIPMENT_CANCEL_LINE,
          sourceId: line.id,
          sourceKey: buildFinishedGoodsShipmentCancelLineSourceKey(line.id),
          comment: `Отмена отгрузки готовой продукции: ${reason}`,
          createdById: employeeId ?? null,
        });
      }

      // 3. Audit пишется в той же транзакции — либо документ
      // (status=CANCELLED) + N REVERSAL IN + AuditLog атомарно, либо
      // ничего.
      await this.audit.log(
        {
          event: 'FINISHED_GOODS_SHIPMENT_CANCELLED',
          entityType: 'FINISHED_GOODS_SHIPMENT',
          entityId: shipment.id,
          employeeId: employeeId ?? null,
          payload: {
            finishedGoodsShipmentId: shipment.id,
            number: shipment.number,
            orderId: shipment.orderId,
            cancelledAt: cancelledAt.toISOString(),
            cancelReason: reason,
            lines: shipment.lines.map((line) => ({
              finishedGoodsShipmentLineId: line.id,
              finishedGoodsBalanceId: line.finishedGoodsBalanceId,
              productId: line.productId,
              sizeId: line.sizeId,
              color: line.color,
              warehouseId: line.warehouseId,
              cellId: line.cellId,
              qty: line.qty,
            })),
            employeeId: employeeId ?? null,
            timestamp: cancelledAt.toISOString(),
          } as Prisma.InputJsonValue,
        },
        tx,
      );

      this.logger.log(
        `event=finished_goods.shipment.cancel shipmentId=${shipment.id} ` +
          `number=${shipment.number} orderId=${shipment.orderId} ` +
          `lines=${shipment.lines.length} totalQty=${shipment.lines.reduce(
            (acc, l) => acc + l.qty,
            0,
          )}`,
      );

      const reloaded = await tx.finishedGoodsShipment.findUniqueOrThrow({
        where: { id: shipment.id },
        include: SHIPMENT_DETAIL_INCLUDE,
      });
      return reloaded;
    });

    return toShipmentDetailDto(detail);
  }

  // ===========================================================================
  // TRANSFER — перемещение готовой продукции между складами / ячейками
  // ===========================================================================

  /**
   * Перемещение готовой продукции между складами / ячейками
   * (см. `apps/api/src/modules/finished-goods/dto/create-finished-goods-transfer.dto.ts`,
   * `docs/api.md §«Finished goods transfers»`).
   *
   * Контракт MVP:
   *   - открывает свою `prisma.$transaction(...)`;
   *   - находит исходный `FinishedGoodsBalance` по
   *     `fromFinishedGoodsBalanceId` и достаёт `orderId`, `productId`,
   *     `sizeId`, `color`, `warehouseId`, `cellId` — клиент эти поля не
   *     присылает;
   *   - проверяет, что `qty > 0` (целое) и `source.qty >= qty`
   *     (transfer всегда strict; готовая продукция не уходит в минус);
   *   - при `toCellId` — `Cell.warehouseId` (с fallback на
   *     `toWarehouseId`) определяет destination warehouse, иначе
   *     `cellId = null`;
   *   - запрещает same-location transfer (409
   *     `FINISHED_GOODS_TRANSFER_SAME_LOCATION`);
   *   - пишет пару `FinishedGoodsMovement` `type = TRANSFER`:
   *     `direction = OUT` (sourceKey
   *     `FINISHED_GOODS_TRANSFER:<id>:OUT`) уменьшает исходный остаток,
   *     `direction = IN` (sourceKey
   *     `FINISHED_GOODS_TRANSFER:<id>:IN`) создаёт / увеличивает
   *     целевой `FinishedGoodsBalance`;
   *   - идемпотентен по `clientRequestId`: если оба ключа уже
   *     существуют, возвращает существующую пару и не апдейтит баланс.
   *     Если найден только один — поднимает 409
   *     `FINISHED_GOODS_TRANSFER_INCONSISTENT_STATE`;
   *   - пишет audit `FINISHED_GOODS_TRANSFER_CREATED` под
   *     `entityType = FINISHED_GOODS_MOVEMENT` (`entityId = OUT.id`) в
   *     той же транзакции.
   *
   * Сознательная граница MVP: НЕ создаём отдельную модель
   * `FinishedGoodsTransfer`, transfer представлен парой
   * `FinishedGoodsMovement` `type = TRANSFER`. Не затрагивает
   * материалы (`StockBalance` / `StockMovement` / `MaterialIssue` /
   * `PurchaseReceipt` / `StockAdjustment` / `StockTransfer` /
   * `CostsService` / `ProductionCostV2Service`).
   */
  async createTransfer(
    dto: CreateFinishedGoodsTransferDto,
    employeeId: string | null | undefined,
  ): Promise<{
    transferId: string;
    outMovement: FinishedGoodsMovementListItem;
    inMovement: FinishedGoodsMovementListItem;
  }> {
    await this.assertErpDoesNotOwnFinishedGoods('перемещение');
    if (!Number.isInteger(dto.qty) || dto.qty <= 0) {
      throw new BusinessException(
        'FINISHED_GOODS_TRANSFER_QTY_INVALID',
        'Количество перемещения готовой продукции должно быть целым положительным числом.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const clientRequestId = dto.clientRequestId ?? randomUUID();
    const transferId = clientRequestId;
    const outSourceKey = buildFinishedGoodsTransferOutSourceKey(transferId);
    const inSourceKey = buildFinishedGoodsTransferInSourceKey(transferId);

    const { outMovementId, inMovementId } = await this.prisma.$transaction(
      async (tx) => {
        // ---- idempotency: оба ключа уже есть -------------------------------
        const existingOut = await tx.finishedGoodsMovement.findUnique({
          where: { sourceKey: outSourceKey },
        });
        const existingIn = await tx.finishedGoodsMovement.findUnique({
          where: { sourceKey: inSourceKey },
        });
        if (existingOut && existingIn) {
          return {
            outMovementId: existingOut.id,
            inMovementId: existingIn.id,
          };
        }
        if (existingOut || existingIn) {
          throw new BusinessException(
            'FINISHED_GOODS_TRANSFER_INCONSISTENT_STATE',
            'Перемещение готовой продукции находится в несогласованном состоянии (есть только OUT или только IN).',
            HttpStatus.CONFLICT,
          );
        }

        // ---- source ----------------------------------------------------------
        const source = await tx.finishedGoodsBalance.findUnique({
          where: { id: dto.fromFinishedGoodsBalanceId },
        });
        if (!source) {
          throw new BusinessException(
            'FINISHED_GOODS_BALANCE_NOT_FOUND',
            'Исходный остаток готовой продукции не найден.',
            HttpStatus.NOT_FOUND,
          );
        }
        if (source.qty < dto.qty) {
          throw new BusinessException(
            'FINISHED_GOODS_INSUFFICIENT_BALANCE',
            `Недостаточно остатка готовой продукции: доступно ${source.qty}, требуется ${dto.qty}.`,
            HttpStatus.CONFLICT,
          );
        }

        // ---- destination -----------------------------------------------------
        let destWarehouseId: string | null;
        let destCellId: string | null;
        if (dto.toCellId) {
          const cell = await tx.cell.findUnique({
            where: { id: dto.toCellId },
            select: { id: true, warehouseId: true },
          });
          if (!cell) {
            throw new BusinessException(
              'FINISHED_GOODS_TRANSFER_CELL_NOT_FOUND',
              'Целевая ячейка не найдена.',
              HttpStatus.NOT_FOUND,
            );
          }
          destCellId = cell.id;
          destWarehouseId = cell.warehouseId ?? dto.toWarehouseId ?? null;
        } else {
          destCellId = null;
          destWarehouseId = dto.toWarehouseId ?? null;
        }

        // ---- same-location гейт ---------------------------------------------
        if (
          (source.warehouseId ?? null) === destWarehouseId &&
          (source.cellId ?? null) === destCellId
        ) {
          throw new BusinessException(
            'FINISHED_GOODS_TRANSFER_SAME_LOCATION',
            'Источник и назначение перемещения готовой продукции совпадают.',
            HttpStatus.CONFLICT,
          );
        }

        // ---- OUT (списание из source) ---------------------------------------
        const { movement: outMovement } = await this.applyMovementInTx(tx, {
          orderId: source.orderId,
          productId: source.productId,
          sizeId: source.sizeId,
          color: source.color,
          warehouseId: source.warehouseId,
          cellId: source.cellId,
          type: FINISHED_GOODS_MOVEMENT_TYPE.TRANSFER,
          direction: FINISHED_GOODS_MOVEMENT_DIRECTION.OUT,
          qty: dto.qty,
          sourceType: FINISHED_GOODS_SOURCE_TYPE.FINISHED_GOODS_TRANSFER,
          sourceId: transferId,
          sourceKey: outSourceKey,
          comment: dto.comment,
          createdById: employeeId ?? null,
        });

        // ---- IN (зачисление в destination) ----------------------------------
        const { movement: inMovement, balance: destBalance } =
          await this.applyMovementInTx(tx, {
            orderId: source.orderId,
            productId: source.productId,
            sizeId: source.sizeId,
            color: source.color,
            warehouseId: destWarehouseId,
            cellId: destCellId,
            type: FINISHED_GOODS_MOVEMENT_TYPE.TRANSFER,
            direction: FINISHED_GOODS_MOVEMENT_DIRECTION.IN,
            qty: dto.qty,
            sourceType: FINISHED_GOODS_SOURCE_TYPE.FINISHED_GOODS_TRANSFER,
            sourceId: transferId,
            sourceKey: inSourceKey,
            comment: dto.comment,
            createdById: employeeId ?? null,
          });

        // ---- audit ----------------------------------------------------------
        await this.audit.log(
          {
            event: 'FINISHED_GOODS_TRANSFER_CREATED',
            entityType: 'FINISHED_GOODS_MOVEMENT',
            entityId: outMovement.id,
            employeeId: employeeId ?? null,
            payload: {
              sourceType: FINISHED_GOODS_SOURCE_TYPE.FINISHED_GOODS_TRANSFER,
              transferId,
              fromFinishedGoodsBalanceId: source.id,
              toFinishedGoodsBalanceId: destBalance.id,
              outMovementId: outMovement.id,
              inMovementId: inMovement.id,
              orderId: source.orderId,
              productId: source.productId,
              sizeId: source.sizeId,
              color: source.color,
              qty: dto.qty,
              from: {
                warehouseId: source.warehouseId ?? null,
                cellId: source.cellId ?? null,
              },
              to: {
                warehouseId: destWarehouseId,
                cellId: destCellId,
              },
              comment: dto.comment,
              employeeId: employeeId ?? null,
              timestamp: outMovement.createdAt.toISOString(),
            } as Prisma.InputJsonValue,
          },
          tx,
        );

        return {
          outMovementId: outMovement.id,
          inMovementId: inMovement.id,
        };
      },
    );

    this.logger.log(
      `event=finished_goods.transfer.create transferId=${transferId} ` +
        `out=${outMovementId} in=${inMovementId} qty=${dto.qty} ` +
        `fromFinishedGoodsBalanceId=${dto.fromFinishedGoodsBalanceId}`,
    );

    // Возвращаем пару движений в shape `FinishedGoodsMovementListItem` —
    // тот же, что отдаёт `GET /api/finished-goods/movements`. `sourceKey`
    // сознательно не пробрасываем (`toMovementListItem` его вырезает).
    const [outDetail, inDetail] = await Promise.all([
      this.prisma.finishedGoodsMovement.findUniqueOrThrow({
        where: { id: outMovementId },
        include: MOVEMENT_LIST_INCLUDE,
      }),
      this.prisma.finishedGoodsMovement.findUniqueOrThrow({
        where: { id: inMovementId },
        include: MOVEMENT_LIST_INCLUDE,
      }),
    ]);

    return {
      transferId,
      outMovement: toMovementListItem(outDetail),
      inMovement: toMovementListItem(inDetail),
    };
  }

  // ===========================================================================
  // ADJUSTMENT — ручная корректировка остатка готовой продукции
  // ===========================================================================

  /**
   * Ручная корректировка остатка готовой продукции (см.
   * `apps/api/src/modules/finished-goods/dto/create-finished-goods-adjustment.dto.ts`,
   * `docs/api.md §«Finished goods adjustments»`).
   *
   * Контракт MVP:
   *   - открывает свою `prisma.$transaction(...)`;
   *   - находит `FinishedGoodsBalance` по `finishedGoodsBalanceId`,
   *     достаёт `orderId`, `productId`, `sizeId`, `color`,
   *     `warehouseId`, `cellId` — клиент эти поля не присылает;
   *   - проверяет, что `qty > 0` (целое) и `direction ∈ {IN, OUT}`;
   *   - для `OUT` — strict: `source.qty >= qty`. Готовая продукция не
   *     уходит в минус (нет аналога `allowNegativeMaterialStock`,
   *     `applyMovementInTx` сам отклонит OUT, который уведёт баланс
   *     ниже нуля);
   *   - идемпотентен по `clientRequestId`: один `clientRequestId` →
   *     одно движение `type = ADJUSTMENT`. Повторный submit формы
   *     возвращает существующее движение и НЕ изменяет баланс
   *     повторно;
   *   - пишет audit `FINISHED_GOODS_ADJUSTMENT_CREATED` под
   *     `entityType = FINISHED_GOODS_MOVEMENT` (`entityId =
   *     FinishedGoodsMovement.id`) в той же транзакции.
   *
   * Сознательная граница MVP: НЕ создаём отдельную модель
   * `FinishedGoodsAdjustment`, корректировка полностью представлена
   * одним `FinishedGoodsMovement`. Не затрагивает материалы
   * (`StockBalance` / `StockMovement` / `MaterialIssue` /
   * `PurchaseReceipt` / `StockAdjustment` / `StockTransfer` /
   * `CostsService` / `ProductionCostV2Service`).
   */
  async createAdjustment(
    dto: CreateFinishedGoodsAdjustmentDto,
    employeeId: string | null | undefined,
  ): Promise<FinishedGoodsMovementListItem> {
    await this.assertErpDoesNotOwnFinishedGoods('корректировка');
    if (!Number.isInteger(dto.qty) || dto.qty <= 0) {
      throw new BusinessException(
        'FINISHED_GOODS_ADJUSTMENT_QTY_INVALID',
        'Количество корректировки готовой продукции должно быть целым положительным числом.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      dto.direction !== FINISHED_GOODS_MOVEMENT_DIRECTION.IN &&
      dto.direction !== FINISHED_GOODS_MOVEMENT_DIRECTION.OUT
    ) {
      throw new BusinessException(
        'FINISHED_GOODS_MOVEMENT_DIRECTION_INVALID',
        'Недопустимое направление корректировки готовой продукции (ожидается IN или OUT).',
        HttpStatus.BAD_REQUEST,
      );
    }

    const clientRequestId = dto.clientRequestId ?? randomUUID();
    const adjustmentId = clientRequestId;
    const sourceKey = buildFinishedGoodsAdjustmentSourceKey(adjustmentId);

    const movementId = await this.prisma.$transaction(async (tx) => {
      // Идемпотентность: один `clientRequestId` → одно движение.
      // Не пишем audit повторно, не апдейтим `FinishedGoodsBalance`.
      const existing = await tx.finishedGoodsMovement.findUnique({
        where: { sourceKey },
      });
      if (existing) {
        return existing.id;
      }

      const balance = await tx.finishedGoodsBalance.findUnique({
        where: { id: dto.finishedGoodsBalanceId },
      });
      if (!balance) {
        throw new BusinessException(
          'FINISHED_GOODS_BALANCE_NOT_FOUND',
          'Остаток готовой продукции не найден.',
          HttpStatus.NOT_FOUND,
        );
      }

      const isOut =
        dto.direction === FINISHED_GOODS_MOVEMENT_DIRECTION.OUT;
      // Pre-check для OUT: явный 409 с понятным `code`, чтобы UI отрисовал
      // backend-message без raw JSON. `applyMovementInTx` всё равно
      // подстрахует от race-condition тем же кодом.
      if (isOut && balance.qty < dto.qty) {
        throw new BusinessException(
          'FINISHED_GOODS_INSUFFICIENT_BALANCE',
          `Недостаточно остатка готовой продукции: доступно ${balance.qty}, требуется ${dto.qty}.`,
          HttpStatus.CONFLICT,
        );
      }

      const { movement: created, balance: updated } =
        await this.applyMovementInTx(tx, {
          orderId: balance.orderId,
          productId: balance.productId,
          sizeId: balance.sizeId,
          color: balance.color,
          warehouseId: balance.warehouseId,
          cellId: balance.cellId,
          type: FINISHED_GOODS_MOVEMENT_TYPE.ADJUSTMENT,
          direction: dto.direction,
          qty: dto.qty,
          sourceType: FINISHED_GOODS_SOURCE_TYPE.FINISHED_GOODS_ADJUSTMENT,
          sourceId: adjustmentId,
          sourceKey,
          comment: dto.comment,
          createdById: employeeId ?? null,
        });

      await this.audit.log(
        {
          event: 'FINISHED_GOODS_ADJUSTMENT_CREATED',
          entityType: 'FINISHED_GOODS_MOVEMENT',
          entityId: created.id,
          employeeId: employeeId ?? null,
          payload: {
            sourceType: FINISHED_GOODS_SOURCE_TYPE.FINISHED_GOODS_ADJUSTMENT,
            adjustmentId,
            finishedGoodsBalanceId: updated.id,
            movementId: created.id,
            orderId: created.orderId,
            productId: created.productId,
            sizeId: created.sizeId,
            color: created.color,
            warehouseId: created.warehouseId,
            cellId: created.cellId,
            direction: created.direction,
            qty: created.qty,
            balanceBeforeQty: created.balanceBeforeQty,
            balanceAfterQty: created.balanceAfterQty,
            comment: created.comment,
            employeeId: employeeId ?? null,
            timestamp: created.createdAt.toISOString(),
          } as Prisma.InputJsonValue,
        },
        tx,
      );

      return created.id;
    });

    this.logger.log(
      `event=finished_goods.adjustment.create id=${movementId} ` +
        `direction=${dto.direction} qty=${dto.qty} ` +
        `finishedGoodsBalanceId=${dto.finishedGoodsBalanceId} ` +
        `sourceKey=${sourceKey}`,
    );

    // Возвращаем item в shape `FinishedGoodsMovementListItem` — тот
    // же, что отдаёт `GET /api/finished-goods/movements`. `sourceKey`
    // сознательно НЕ отдаём наружу.
    const detail =
      await this.prisma.finishedGoodsMovement.findUniqueOrThrow({
        where: { id: movementId },
        include: MOVEMENT_LIST_INCLUDE,
      });
    return toMovementListItem(detail);
  }
}

// ---------------------------------------------------------------------------
// helpers (file-private)
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;

const BALANCE_LIST_INCLUDE = {
  order: {
    select: {
      id: true,
      number: true,
      client: { select: { id: true, name: true } },
    },
  },
  product: { select: { id: true, name: true } },
  size: { select: { id: true, code: true } },
  warehouse: { select: { id: true, name: true, code: true } },
  cell: { select: { id: true, code: true } },
} as const satisfies Prisma.FinishedGoodsBalanceInclude;

const MOVEMENT_LIST_INCLUDE = {
  order: {
    select: {
      id: true,
      number: true,
      // Client management chain (см. `prisma/schema.prisma::Order.clientId`,
      // `model Client`). Read-only — журнал движений показывает заказчика
      // в `/admin/warehouses?tab=movements` (колонка «Заказчик»).
      client: { select: { id: true, name: true } },
    },
  },
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
  /** `Order.clientId` — управленческая привязка к карточке клиента. */
  clientId: string | null;
  /** `Client.name` — отображается в UI («Заказчик»). */
  clientName: string | null;
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
  /** `Order.clientId` — управленческая привязка к карточке клиента. */
  clientId: string | null;
  /** `Client.name` — отображается в UI журнала движений склада. */
  clientName: string | null;
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
    clientId: row.order?.client?.id ?? null,
    clientName: row.order?.client?.name ?? null,
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
    clientId: row.order?.client?.id ?? null,
    clientName: row.order?.client?.name ?? null,
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

// ---------------------------------------------------------------------------
// Shipment detail DTO + include
// ---------------------------------------------------------------------------

const SHIPMENT_DETAIL_INCLUDE = {
  lines: {
    orderBy: [{ id: 'asc' }],
    include: {
      product: { select: { id: true, name: true } },
      size: { select: { id: true, code: true } },
      warehouse: { select: { id: true, name: true, code: true } },
      cell: { select: { id: true, code: true } },
    },
  },
} as const satisfies Prisma.FinishedGoodsShipmentInclude;

type ShipmentWithRels = Prisma.FinishedGoodsShipmentGetPayload<{
  include: typeof SHIPMENT_DETAIL_INCLUDE;
}>;

export interface FinishedGoodsShipmentLineDto {
  id: string;
  finishedGoodsBalanceId: string | null;
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
  comment: string | null;
}

export interface FinishedGoodsShipmentDetailDto {
  id: string;
  number: string;
  orderId: string;
  status: string;
  shippedAt: string;
  comment: string | null;
  createdAt: string;
  createdById: string | null;
  /**
   * Поля отмены отгрузки. Если `status === 'CANCELLED'` — все три
   * заполнены; если `status === 'POSTED'` — все три `null`. См.
   * `FinishedGoodsService.cancelShipment` и
   * `prisma/schema.prisma::FinishedGoodsShipment`.
   */
  cancelledAt: string | null;
  cancelledById: string | null;
  cancelReason: string | null;
  lines: FinishedGoodsShipmentLineDto[];
  // sourceKey намеренно не возвращается — внутренний идемпотентный ключ
  // (FINISHED_GOODS_SHIPMENT:<orderId>:<clientRequestId>).
}

function toShipmentDetailDto(
  row: ShipmentWithRels,
): FinishedGoodsShipmentDetailDto {
  return {
    id: row.id,
    number: row.number,
    orderId: row.orderId,
    status: row.status,
    shippedAt: row.shippedAt.toISOString(),
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    cancelledById: row.cancelledById,
    cancelReason: row.cancelReason,
    lines: row.lines.map((line) => ({
      id: line.id,
      finishedGoodsBalanceId: line.finishedGoodsBalanceId,
      productId: line.productId,
      productName: line.product?.name ?? null,
      sizeId: line.sizeId,
      sizeCode: line.size?.code ?? null,
      color: line.color,
      warehouseId: line.warehouseId,
      warehouseName: line.warehouse?.name ?? null,
      cellId: line.cellId,
      cellCode: line.cell?.code ?? null,
      qty: line.qty,
      comment: line.comment,
    })),
  };
}
