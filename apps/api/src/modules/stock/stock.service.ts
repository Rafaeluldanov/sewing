import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type StockBalance, type StockMovement } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import {
  BusinessException,
  MaterialStockInsufficientException,
} from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CompanySettingsService } from '../company-settings/company-settings.service.js';
import type { CreateStockAdjustmentDto } from './dto/create-stock-adjustment.dto.js';
import type { CreateStockTransferDto } from './dto/create-stock-transfer.dto.js';
import type { ListStockBalancesQuery } from './dto/list-stock-balances.dto.js';
import type { ListStockMovementsQuery } from './dto/list-stock-movements.dto.js';
import {
  STOCK_MOVEMENT_DIRECTION,
  STOCK_MOVEMENT_TYPE,
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
  /**
   * Идемпотентный технический ключ движения. Если строка с таким
   * `sourceKey` уже есть в `StockMovement` (UNIQUE), повторный вызов
   * пишет дубль (`P2002`). Бизнес-сервисы должны заранее проверять
   * существование через {@link StockService.findMovementBySourceKeyInTx}.
   *
   * Формат — строковые префиксы (см. helpers ниже):
   *   - `PURCHASE_RECEIPT_LINE:<purchaseReceiptLineId>` — приход;
   *   - `PURCHASE_RECEIPT_LINE_CANCEL:<purchaseReceiptLineId>` —
   *     обратное движение при отмене приёмки;
   *   - `MATERIAL_ISSUE_LINE:<materialIssueLineId>` — расход при
   *     проведении `MaterialIssue` (в т.ч. `AUTO_CUT_ISSUE`).
   */
  sourceKey?: string | null;
  purchaseReceiptId?: string | null;
  purchaseReceiptLineId?: string | null;
  materialIssueId?: string | null;
  materialIssueLineId?: string | null;
  comment?: string | null;
  createdById?: string | null;
  /**
   * Hardening-флаг: разрешать ли OUT-движение, которое уведёт
   * `StockBalance.qty` в минус
   * (см. `prisma/schema.prisma::CompanySettings.allowNegativeMaterialStock`,
   * `apps/api/src/modules/material-issues/material-issues.service.ts`).
   *
   * - `true` (default) или не передан: текущее MVP-поведение —
   *   OUT пишется даже при недостатке остатка, `StockBalance.qty`
   *   может уйти в минус (foundation).
   * - `false`: перед записью OUT сервис проверяет, что
   *   `balanceAfterQty >= 0`; иначе бросает
   *   {@link MaterialStockInsufficientException} (409), не пишет
   *   `StockMovement` и не апдейтит `StockBalance`.
   *
   * IN-движение от значения флага НЕ зависит — `IN` всегда
   * увеличивает остаток.
   */
  allowNegativeStock?: boolean;
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
 * Префиксы идемпотентного `StockMovement.sourceKey`. Хранятся в одном
 * месте, чтобы сервисная логика и тесты не разъезжались по строковому
 * литералу.
 */
export const STOCK_MOVEMENT_SOURCE_KEY_PREFIX = {
  PURCHASE_RECEIPT_LINE: 'PURCHASE_RECEIPT_LINE',
  PURCHASE_RECEIPT_LINE_CANCEL: 'PURCHASE_RECEIPT_LINE_CANCEL',
  MATERIAL_ISSUE_LINE: 'MATERIAL_ISSUE_LINE',
  /**
   * Префикс ключа IN-движения возврата проведённого `MaterialIssue`.
   * Один `MaterialIssueReturnLine` → одно зачисляющее движение
   * `direction = IN`, `type = REVERSAL`. См.
   * `StockService.recordMaterialIssueReturnInTx`,
   * `prisma/schema.prisma::MaterialIssueReturnLine`,
   * `docs/current-state.md §«Material issue return»`.
   */
  MATERIAL_ISSUE_RETURN_LINE: 'MATERIAL_ISSUE_RETURN_LINE',
  /**
   * Префикс ключа ручной корректировки остатка (см.
   * `StockService.createAdjustment`,
   * `apps/api/src/modules/stock/dto/create-stock-adjustment.dto.ts`,
   * UI — `/admin/warehouses?tab=balances`). Один `clientRequestId`
   * формы → одно `StockMovement` (защита от двойного submit).
   */
  STOCK_ADJUSTMENT: 'STOCK_ADJUSTMENT',
  /**
   * Префикс ключей пары движений склад-в-склад / ячейка-в-ячейка
   * (см. `StockService.createTransfer`,
   * `apps/api/src/modules/stock/dto/create-stock-transfer.dto.ts`,
   * UI — `/admin/warehouses?tab=balances`, кнопка «Переместить»).
   * Один transfer пишется как пара `StockMovement`:
   *   - `STOCK_TRANSFER:<clientRequestId>:OUT` — списание с источника;
   *   - `STOCK_TRANSFER:<clientRequestId>:IN` — зачисление в назначение.
   * `UNIQUE` на `StockMovement.sourceKey` гарантирует, что повторный
   * submit с тем же `clientRequestId` не задвоит ни OUT, ни IN.
   */
  STOCK_TRANSFER: 'STOCK_TRANSFER',
} as const;

/**
 * Ключ IN-движения по приёмке: один `PurchaseReceiptLine` → одно
 * движение.
 */
export function buildPurchaseReceiptLineStockSourceKey(
  purchaseReceiptLineId: string,
): string {
  return `${STOCK_MOVEMENT_SOURCE_KEY_PREFIX.PURCHASE_RECEIPT_LINE}:${purchaseReceiptLineId}`;
}

/**
 * Ключ REVERSAL-движения при отмене приёмки: одна строка → один
 * сторнирующий OUT.
 */
export function buildPurchaseReceiptLineCancelStockSourceKey(
  purchaseReceiptLineId: string,
): string {
  return `${STOCK_MOVEMENT_SOURCE_KEY_PREFIX.PURCHASE_RECEIPT_LINE_CANCEL}:${purchaseReceiptLineId}`;
}

/**
 * Ключ OUT-движения по расходу: один `MaterialIssueLine` → одно
 * движение. См. `StockService.recordMaterialIssueInTx`. IN-движение
 * по возврату проведённого расхода имеет отдельный префикс
 * (`buildMaterialIssueReturnLineStockSourceKey`) — это разные
 * сущности и оба ключа должны существовать одновременно.
 */
export function buildMaterialIssueLineStockSourceKey(
  materialIssueLineId: string,
): string {
  return `${STOCK_MOVEMENT_SOURCE_KEY_PREFIX.MATERIAL_ISSUE_LINE}:${materialIssueLineId}`;
}

/**
 * Ключ IN-движения возврата проведённого `MaterialIssue`: один
 * `MaterialIssueReturnLine` → одно зачисляющее движение
 * (`type = REVERSAL`, `direction = IN`). UNIQUE-индекс на
 * `StockMovement.sourceKey` гарантирует, что повторный вызов
 * `recordMaterialIssueReturnInTx` в той же или новой транзакции
 * не создаст дубль. См.
 * `StockService.recordMaterialIssueReturnInTx`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts::returnPostedIssue`,
 * `prisma/schema.prisma::MaterialIssueReturnLine`.
 */
export function buildMaterialIssueReturnLineStockSourceKey(
  materialIssueReturnLineId: string,
): string {
  return `${STOCK_MOVEMENT_SOURCE_KEY_PREFIX.MATERIAL_ISSUE_RETURN_LINE}:${materialIssueReturnLineId}`;
}

/**
 * Ключ движения ручной корректировки: один `clientRequestId` формы
 * (или сгенерированный сервером uuid) → одно `StockMovement`. Защита
 * от двойного submit формы «Корректировка» в `/admin/warehouses?tab=balances`.
 */
export function buildStockAdjustmentSourceKey(clientRequestId: string): string {
  return `${STOCK_MOVEMENT_SOURCE_KEY_PREFIX.STOCK_ADJUSTMENT}:${clientRequestId}`;
}

/**
 * Ключ OUT-движения склад-в-склад: списание с исходного `StockBalance`.
 * Один `clientRequestId` → одно OUT-движение.
 */
export function buildStockTransferOutSourceKey(
  clientRequestId: string,
): string {
  return `${STOCK_MOVEMENT_SOURCE_KEY_PREFIX.STOCK_TRANSFER}:${clientRequestId}:OUT`;
}

/**
 * Ключ IN-движения склад-в-склад: зачисление в целевой `StockBalance`.
 * Один `clientRequestId` → одно IN-движение.
 */
export function buildStockTransferInSourceKey(
  clientRequestId: string,
): string {
  return `${STOCK_MOVEMENT_SOURCE_KEY_PREFIX.STOCK_TRANSFER}:${clientRequestId}:IN`;
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
  private readonly logger = new Logger(StockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly companySettings: CompanySettingsService,
  ) {}

  /**
   * Read-only list `StockBalance` для `GET /api/stock/balances`.
   *
   * Сортировка: `updatedAt desc`, затем `description asc` (стабильный
   * порядок при одновременных движениях).
   *
   * `Decimal` в response отдаём строкой через `.toString()` — так же,
   * как делают остальные read-only сериализаторы складских / закупочных
   * модулей (см. `MaterialIssuesService.toListItem`,
   * `PurchaseReceiptsService`). Это держит точность при JSON-
   * сериализации и не зависит от настройки Prisma Decimal.
   */
  async listBalances(query: ListStockBalancesQuery): Promise<{
    items: StockBalanceListItem[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const offset = query.offset ?? 0;
    const where = buildStockBalanceWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockBalance.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { description: 'asc' }],
        take: limit,
        skip: offset,
        include: STOCK_BALANCE_LIST_INCLUDE,
      }),
      this.prisma.stockBalance.count({ where }),
    ]);
    return {
      items: rows.map(toStockBalanceListItem),
      total,
      limit,
      offset,
    };
  }

  /**
   * Read-only list `StockMovement` для `GET /api/stock/movements`.
   *
   * Сортировка: `createdAt desc` — это журнал движений, важен порядок
   * фиксации. `Decimal` сериализуются как строки (см. `listBalances`).
   *
   * `sourceKey` НЕ отдаётся — это внутренний идемпотентный ключ
   * (`PURCHASE_RECEIPT_LINE:<id>` и т.п.). Sorting по нему тоже не
   * нужен.
   */
  async listMovements(query: ListStockMovementsQuery): Promise<{
    items: StockMovementListItem[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const offset = query.offset ?? 0;
    const where = buildStockMovementWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
        include: STOCK_MOVEMENT_LIST_INCLUDE,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return {
      items: rows.map(toStockMovementListItem),
      total,
      limit,
      offset,
    };
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

    // Hardening-гейт: OUT-движение, уводящее остаток в минус,
    // блокируется, если вызывающий явно передал
    // `allowNegativeStock = false`. По умолчанию (`undefined` /
    // `true`) поведение остаётся permissive — старые сценарии
    // (PurchaseReceipt reversal, foundation-тесты) работают как
    // раньше. См.
    // `prisma/schema.prisma::CompanySettings.allowNegativeMaterialStock`,
    // `apps/api/src/modules/material-issues/material-issues.service.ts`.
    if (
      !isIn &&
      params.allowNegativeStock === false &&
      balanceAfterQty.lt(0)
    ) {
      const description = balance.description ?? params.description;
      throw new MaterialStockInsufficientException(
        `Недостаточно остатка материала «${description}» (${params.unit}): запрошено ${params.qty.toString()}, доступно ${balanceBeforeQty.toString()}.`,
        {
          workshopNeedId: params.workshopNeedId,
          warehouseId: balance.warehouseId ?? null,
          cellId: balance.cellId ?? null,
          requestedQty: params.qty.toString(),
          availableQty: balanceBeforeQty.toString(),
          unit: params.unit,
          description,
        },
      );
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
        sourceKey: params.sourceKey ?? null,
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

  /**
   * Поиск ранее созданного движения по идемпотентному `sourceKey`.
   * Используется бизнес-сервисами перед записью, чтобы retry не
   * пересчитал остаток повторно.
   */
  async findMovementBySourceKeyInTx(
    tx: Prisma.TransactionClient,
    sourceKey: string,
  ): Promise<StockMovement | null> {
    return tx.stockMovement.findUnique({ where: { sourceKey } });
  }

  // ===========================================================================
  // PURCHASE RECEIPT → IN movements
  // ===========================================================================

  /**
   * Записывает входящие движения по `POSTED PurchaseReceipt`.
   *
   * Контракт:
   *   - работает строго внутри переданного `tx`, новую транзакцию не
   *     открывает;
   *   - для каждой подходящей `PurchaseReceiptLine` создаёт `StockMovement`
   *     с `direction = IN`, `type = PURCHASE_RECEIPT` и
   *     `sourceKey = PURCHASE_RECEIPT_LINE:<lineId>`;
   *   - `applyMovementInTx` параллельно увеличивает `StockBalance.qty`
   *     и пересчитывает среднюю себестоимость (см. JSDoc класса);
   *   - идемпотентен: если движение по `sourceKey` уже существует,
   *     строка пропускается без побочных эффектов.
   *
   * Soft-skip строки (без бросания ошибки, чтобы приёмка прошла):
   *   - `PurchaseReceipt.status !== POSTED` или
   *     `PurchaseReceiptLine.status === CANCELLED`;
   *   - нет `workshopNeedId` (foundation использует `WorkshopNeed`
   *     как material identity);
   *   - `receivedQty <= 0`;
   *   - пустой `unit`.
   *
   * Возвращает массив созданных/найденных движений (чисто
   * информативно — основной side effect лежит в БД).
   */
  async recordPurchaseReceiptInTx(
    tx: Prisma.TransactionClient,
    purchaseReceiptId: string,
    employeeId?: string | null,
  ): Promise<StockMovement[]> {
    const receipt = await tx.purchaseReceipt.findUnique({
      where: { id: purchaseReceiptId },
      include: {
        lines: {
          include: {
            workshopNeed: {
              select: {
                id: true,
                description: true,
                sourceName: true,
                materialRole: true,
                unit: true,
              },
            },
            cell: { select: { id: true, warehouseId: true } },
          },
        },
      },
    });
    if (!receipt) return [];
    if (receipt.status !== 'POSTED') return [];

    const movements: StockMovement[] = [];
    for (const line of receipt.lines) {
      const movement = await this.applyPurchaseReceiptLineInTx(
        tx,
        receipt.id,
        line,
        employeeId ?? null,
      );
      if (movement) movements.push(movement);
    }
    return movements;
  }

  private async applyPurchaseReceiptLineInTx(
    tx: Prisma.TransactionClient,
    purchaseReceiptId: string,
    line: Prisma.PurchaseReceiptLineGetPayload<{
      include: {
        workshopNeed: {
          select: {
            id: true;
            description: true;
            sourceName: true;
            materialRole: true;
            unit: true;
          };
        };
        cell: { select: { id: true; warehouseId: true } };
      };
    }>,
    employeeId: string | null,
  ): Promise<StockMovement | null> {
    if (line.status === 'CANCELLED') return null;
    if (!line.workshopNeedId || !line.workshopNeed) {
      this.logger.log(
        `event=stock.purchase_receipt.skip reason=no_workshop_need ` +
          `purchaseReceiptId=${purchaseReceiptId} purchaseReceiptLineId=${line.id}`,
      );
      return null;
    }
    if (!line.unit || line.unit.length === 0) {
      this.logger.log(
        `event=stock.purchase_receipt.skip reason=no_unit ` +
          `purchaseReceiptId=${purchaseReceiptId} purchaseReceiptLineId=${line.id}`,
      );
      return null;
    }
    const qty = line.receivedQty;
    if (!qty || qty.lessThanOrEqualTo(0)) {
      this.logger.log(
        `event=stock.purchase_receipt.skip reason=non_positive_qty ` +
          `purchaseReceiptId=${purchaseReceiptId} purchaseReceiptLineId=${line.id}`,
      );
      return null;
    }

    const sourceKey = buildPurchaseReceiptLineStockSourceKey(line.id);
    const existing = await this.findMovementBySourceKeyInTx(tx, sourceKey);
    if (existing) return existing;

    const warehouseId = line.cell?.warehouseId ?? null;
    const cellId = line.cellId ?? null;
    const unitCost = resolvePurchaseReceiptLineUnitCost(line);
    const description =
      pickFirstNonEmpty([
        line.workshopNeed.description,
        line.workshopNeed.sourceName,
        line.itemNameSnapshot,
      ]) ?? 'Материал';
    const materialRole = line.workshopNeed.materialRole ?? null;
    const unit = line.unit;

    const { movement } = await this.applyMovementInTx(tx, {
      workshopNeedId: line.workshopNeedId,
      warehouseId,
      cellId,
      description,
      materialRole,
      type: STOCK_MOVEMENT_TYPE.PURCHASE_RECEIPT,
      direction: STOCK_MOVEMENT_DIRECTION.IN,
      qty,
      unit,
      unitCost,
      sourceType: STOCK_MOVEMENT_SOURCE_KEY_PREFIX.PURCHASE_RECEIPT_LINE,
      sourceId: line.id,
      sourceKey,
      purchaseReceiptId,
      purchaseReceiptLineId: line.id,
      createdById: employeeId,
    });
    return movement;
  }

  // ===========================================================================
  // PURCHASE RECEIPT CANCEL → REVERSAL OUT movements
  // ===========================================================================

  /**
   * Сторнирует ранее записанные приходные движения при отмене
   * `PurchaseReceipt`.
   *
   * Контракт:
   *   - работает строго внутри переданного `tx`;
   *   - для каждой строки приёмки проверяет, был ли создан исходный
   *     IN (`sourceKey = PURCHASE_RECEIPT_LINE:<lineId>`); если IN не
   *     было — reversal не пишет (старые приёмки до подключения склада
   *     не реверсятся);
   *   - идемпотентен: повторный cancel не создаёт дубль REVERSAL
   *     (UNIQUE на `sourceKey = PURCHASE_RECEIPT_LINE_CANCEL:<lineId>`);
   *   - для reversal используется текущая MVP-логика OUT в
   *     `applyMovementInTx` (без точного FIFO/себестоимости партии);
   *   - отрицательный остаток разрешён.
   */
  async reversePurchaseReceiptInTx(
    tx: Prisma.TransactionClient,
    purchaseReceiptId: string,
    employeeId?: string | null,
  ): Promise<StockMovement[]> {
    const receipt = await tx.purchaseReceipt.findUnique({
      where: { id: purchaseReceiptId },
      include: {
        lines: {
          include: {
            workshopNeed: {
              select: {
                id: true,
                description: true,
                sourceName: true,
                materialRole: true,
                unit: true,
              },
            },
            cell: { select: { id: true, warehouseId: true } },
          },
        },
      },
    });
    if (!receipt) return [];

    const movements: StockMovement[] = [];
    for (const line of receipt.lines) {
      const movement = await this.reversePurchaseReceiptLineInTx(
        tx,
        receipt.id,
        line,
        employeeId ?? null,
      );
      if (movement) movements.push(movement);
    }
    return movements;
  }

  private async reversePurchaseReceiptLineInTx(
    tx: Prisma.TransactionClient,
    purchaseReceiptId: string,
    line: Prisma.PurchaseReceiptLineGetPayload<{
      include: {
        workshopNeed: {
          select: {
            id: true;
            description: true;
            sourceName: true;
            materialRole: true;
            unit: true;
          };
        };
        cell: { select: { id: true; warehouseId: true } };
      };
    }>,
    employeeId: string | null,
  ): Promise<StockMovement | null> {
    if (!line.workshopNeedId || !line.workshopNeed) return null;
    if (!line.unit || line.unit.length === 0) return null;

    const inKey = buildPurchaseReceiptLineStockSourceKey(line.id);
    const original = await this.findMovementBySourceKeyInTx(tx, inKey);
    if (!original) {
      // Нет исходного IN — это «старая» приёмка до подключения склада.
      // Сознательно не создаём reversal.
      return null;
    }
    const reversalKey = buildPurchaseReceiptLineCancelStockSourceKey(line.id);
    const existingReversal = await this.findMovementBySourceKeyInTx(
      tx,
      reversalKey,
    );
    if (existingReversal) return existingReversal;

    const qty = line.receivedQty;
    if (!qty || qty.lessThanOrEqualTo(0)) return null;

    const warehouseId = original.warehouseId ?? line.cell?.warehouseId ?? null;
    const cellId = original.cellId ?? line.cellId ?? null;
    const description =
      pickFirstNonEmpty([
        line.workshopNeed.description,
        line.workshopNeed.sourceName,
        line.itemNameSnapshot,
      ]) ?? 'Материал';
    const materialRole = line.workshopNeed.materialRole ?? null;
    const unit = line.unit;

    const { movement } = await this.applyMovementInTx(tx, {
      workshopNeedId: line.workshopNeedId,
      warehouseId,
      cellId,
      description,
      materialRole,
      type: STOCK_MOVEMENT_TYPE.REVERSAL,
      direction: STOCK_MOVEMENT_DIRECTION.OUT,
      qty,
      unit,
      // unitCost для OUT не используется в проводке (берётся текущий
      // средний `balance.unitCost`), но передаём 0 для корректности
      // контракта `ApplyMovementInTxParams`.
      unitCost: new Prisma.Decimal(0),
      sourceType: STOCK_MOVEMENT_SOURCE_KEY_PREFIX.PURCHASE_RECEIPT_LINE_CANCEL,
      sourceId: line.id,
      sourceKey: reversalKey,
      purchaseReceiptId,
      purchaseReceiptLineId: line.id,
      comment: 'Отмена приёмки',
      createdById: employeeId,
    });
    return movement;
  }

  // ===========================================================================
  // MATERIAL ISSUE → OUT movements
  // ===========================================================================

  /**
   * Записывает исходящие движения по `POSTED MaterialIssue`.
   *
   * Контракт (см. ТЗ «MaterialIssue → StockMovement OUT»):
   *   - работает строго внутри переданного `tx`, новую транзакцию не
   *     открывает;
   *   - срабатывает только если `MaterialIssue.status === POSTED`
   *     (для `DRAFT` / `CANCELLED` — no-op);
   *   - для каждой подходящей `MaterialIssueLine` создаёт
   *     `StockMovement` с `direction = OUT`, `type = MATERIAL_ISSUE`
   *     и `sourceKey = MATERIAL_ISSUE_LINE:<lineId>`;
   *   - `applyMovementInTx` параллельно уменьшает `StockBalance.qty`
   *     и пересчитывает `totalCost` по текущему среднему
   *     `balance.unitCost` (MVP без FIFO/LIFO);
   *   - идемпотентен: если движение по `sourceKey` уже существует,
   *     строка пропускается без побочных эффектов. Защита от гонки —
   *     UNIQUE на `StockMovement.sourceKey`.
   *
   * Soft-skip строки (без бросания ошибки, чтобы проведение документа
   * не падало):
   *   - нет `workshopNeedId` (foundation использует `WorkshopNeed`
   *     как material identity — без неё склад не знает, что
   *     списывать);
   *   - `issuedQty <= 0`;
   *   - пустой `unit`.
   *
   * Выбор `warehouseId` / `cellId` OUT-движения (MVP-аллокация — ТЗ §6).
   *
   * При `allowNegativeStock = true` (или не передан — default):
   *   1. Если `line.cellId` задан — списываем из этой ячейки
   *      (`warehouseId` берём через `Cell.warehouseId`).
   *   2. Иначе ищем существующий `StockBalance` по
   *      `(workshopNeedId, unit)` с `qty > 0` и выбираем один с
   *      максимальным `qty` — списываем оттуда.
   *   3. Если положительного баланса нет — пишем OUT в
   *      no-location balance (`warehouseId = null`, `cellId = null`),
   *      создавая его при необходимости. Отрицательный физический
   *      остаток на foundation **не блокируется**.
   *
   * При `allowNegativeStock = false` (hardening-гейт по
   * `CompanySettings.allowNegativeMaterialStock`):
   *   1. Если `line.cellId` задан — проверяем именно этот баланс.
   *      Если `qty < issuedQty` — бросаем
   *      {@link MaterialStockInsufficientException} (409). Другой
   *      баланс не используется (одна строка списывается из одной
   *      ячейки — без дробления / FIFO).
   *   2. Если `line.cellId` НЕ задан — ищем самый большой
   *      положительный `StockBalance` по `(workshopNeedId, unit)`.
   *      Если нашли и `qty >= issuedQty` — списываем с него. Если
   *      нашли, но `qty < issuedQty`, или положительного баланса
   *      нет вообще — бросаем `MaterialStockInsufficientException`.
   *      `no-location negative balance` НЕ создаётся.
   *
   * В обоих режимах одна `MaterialIssueLine` → один OUT-`StockMovement`
   * (без дробления одной строки между несколькими остатками; FIFO/LIFO
   * не реализованы).
   *
   * Стоимость (см. `applyMovementInTx`): OUT использует текущий
   * `balance.unitCost`, **не** `MaterialIssueLine.unitCost` — эти две
   * стоимости живут независимо (`MaterialIssue.totalCost` — финансовый
   * snapshot, `StockMovement.totalCost` — складская оценка).
   *
   * `comment` движения зависит от `MaterialIssue.source`:
   *   - `AUTO_CUT_ISSUE` → `'Автоматическое списание при выдаче кроя'`;
   *   - иначе (`MANUAL`, …) → `'Списание по документу расхода материалов'`.
   *
   * Возвращает массив созданных/найденных движений (чисто
   * информативно — основной side effect лежит в БД).
   */
  async recordMaterialIssueInTx(
    tx: Prisma.TransactionClient,
    materialIssueId: string,
    employeeId?: string | null,
    options?: {
      /**
       * Hardening-флаг: разрешать ли OUT-движение, которое уведёт
       * `StockBalance.qty` в минус. По умолчанию — `true` (текущее
       * MVP-поведение). Передаётся вызывающим сервисом
       * (`MaterialIssuesService`) после чтения
       * `CompanySettings.allowNegativeMaterialStock`.
       */
      allowNegativeStock?: boolean;
    },
  ): Promise<StockMovement[]> {
    const issue = await tx.materialIssue.findUnique({
      where: { id: materialIssueId },
      include: {
        lines: {
          include: {
            workshopNeed: {
              select: {
                id: true,
                description: true,
                sourceName: true,
                materialRole: true,
                unit: true,
              },
            },
            cell: { select: { id: true, warehouseId: true } },
          },
        },
      },
    });
    if (!issue) return [];
    if (issue.status !== 'POSTED') return [];

    const comment = buildMaterialIssueStockComment(issue.source);
    const allowNegativeStock = options?.allowNegativeStock ?? true;

    const movements: StockMovement[] = [];
    for (const line of issue.lines) {
      const movement = await this.applyMaterialIssueLineInTx(
        tx,
        issue.id,
        line,
        comment,
        employeeId ?? null,
        allowNegativeStock,
      );
      if (movement) movements.push(movement);
    }
    return movements;
  }

  private async applyMaterialIssueLineInTx(
    tx: Prisma.TransactionClient,
    materialIssueId: string,
    line: Prisma.MaterialIssueLineGetPayload<{
      include: {
        workshopNeed: {
          select: {
            id: true;
            description: true;
            sourceName: true;
            materialRole: true;
            unit: true;
          };
        };
        cell: { select: { id: true; warehouseId: true } };
      };
    }>,
    comment: string,
    employeeId: string | null,
    allowNegativeStock: boolean,
  ): Promise<StockMovement | null> {
    if (!line.workshopNeedId) {
      this.logger.log(
        `event=stock.material_issue.skip reason=no_workshop_need ` +
          `materialIssueId=${materialIssueId} materialIssueLineId=${line.id}`,
      );
      return null;
    }
    if (!line.unit || line.unit.length === 0) {
      this.logger.log(
        `event=stock.material_issue.skip reason=no_unit ` +
          `materialIssueId=${materialIssueId} materialIssueLineId=${line.id}`,
      );
      return null;
    }
    const qty = line.issuedQty;
    if (!qty || qty.lessThanOrEqualTo(0)) {
      this.logger.log(
        `event=stock.material_issue.skip reason=non_positive_qty ` +
          `materialIssueId=${materialIssueId} materialIssueLineId=${line.id}`,
      );
      return null;
    }

    const sourceKey = buildMaterialIssueLineStockSourceKey(line.id);
    const existing = await this.findMovementBySourceKeyInTx(tx, sourceKey);
    if (existing) return existing;

    const description =
      pickFirstNonEmpty([
        line.workshopNeed?.description,
        line.workshopNeed?.sourceName,
        line.description,
      ]) ?? 'Материал';
    const materialRole =
      line.materialRole ?? line.workshopNeed?.materialRole ?? null;
    const unit = line.unit;

    // Аллокация OUT (см. JSDoc `recordMaterialIssueInTx`).
    //
    // Permissive (`allowNegativeStock = true`):
    //   1. explicit `line.cellId` → списываем оттуда;
    //   2. иначе самый большой положительный балас по
    //      `(workshopNeedId, unit)`;
    //   3. иначе no-location negative balance (`applyMovementInTx`
    //      сам создаст его и уведёт в минус).
    //
    // Strict (`allowNegativeStock = false`, hardening-гейт по
    // `CompanySettings.allowNegativeMaterialStock`):
    //   1. explicit `line.cellId` → проверяем именно этот баланс,
    //      `qty < issuedQty` ⇒ ошибка;
    //   2. иначе самый большой положительный, `qty < issuedQty` ⇒
    //      ошибка; нет положительного → ошибка. No-location negative
    //      balance НЕ создаётся.
    let warehouseId: string | null = null;
    let cellId: string | null = null;
    if (line.cellId && line.cell) {
      cellId = line.cellId;
      warehouseId = line.cell.warehouseId ?? null;
      if (!allowNegativeStock) {
        await this.assertCellBalanceSufficientInTx(tx, {
          workshopNeedId: line.workshopNeedId,
          warehouseId,
          cellId,
          requestedQty: qty,
          unit,
          description,
        });
      }
    } else if (!allowNegativeStock) {
      const candidate = await tx.stockBalance.findFirst({
        where: {
          workshopNeedId: line.workshopNeedId,
          unit,
          qty: { gte: qty },
        },
        orderBy: [{ qty: 'desc' }, { updatedAt: 'asc' }],
        select: { id: true, warehouseId: true, cellId: true },
      });
      if (!candidate) {
        // Либо положительного баланса нет вообще, либо самый большой
        // меньше требуемого. В обоих случаях бросаем insufficient —
        // без дробления и без no-location negative balance.
        const best = await tx.stockBalance.findFirst({
          where: { workshopNeedId: line.workshopNeedId, unit },
          orderBy: [{ qty: 'desc' }, { updatedAt: 'asc' }],
          select: { qty: true, warehouseId: true, cellId: true },
        });
        const availableQty = best?.qty ?? new Prisma.Decimal(0);
        throw new MaterialStockInsufficientException(
          `Недостаточно остатка материала «${description}» (${unit}): запрошено ${qty.toString()}, доступно ${availableQty.toString()}.`,
          {
            workshopNeedId: line.workshopNeedId,
            warehouseId: best?.warehouseId ?? null,
            cellId: best?.cellId ?? null,
            requestedQty: qty.toString(),
            availableQty: availableQty.toString(),
            unit,
            description,
          },
        );
      }
      warehouseId = candidate.warehouseId ?? null;
      cellId = candidate.cellId ?? null;
    } else {
      const candidate = await tx.stockBalance.findFirst({
        where: {
          workshopNeedId: line.workshopNeedId,
          unit,
          qty: { gt: 0 },
        },
        orderBy: [{ qty: 'desc' }, { updatedAt: 'asc' }],
        select: { id: true, warehouseId: true, cellId: true },
      });
      if (candidate) {
        warehouseId = candidate.warehouseId ?? null;
        cellId = candidate.cellId ?? null;
      }
    }

    const { movement } = await this.applyMovementInTx(tx, {
      workshopNeedId: line.workshopNeedId,
      warehouseId,
      cellId,
      description,
      materialRole,
      type: STOCK_MOVEMENT_TYPE.MATERIAL_ISSUE,
      direction: STOCK_MOVEMENT_DIRECTION.OUT,
      qty,
      unit,
      // unitCost для OUT не используется в проводке (берётся текущий
      // средний `balance.unitCost`), но `ApplyMovementInTxParams`
      // требует поле — передаём 0.
      unitCost: new Prisma.Decimal(0),
      sourceType: STOCK_MOVEMENT_SOURCE_KEY_PREFIX.MATERIAL_ISSUE_LINE,
      sourceId: line.id,
      sourceKey,
      materialIssueId,
      materialIssueLineId: line.id,
      comment,
      createdById: employeeId,
      allowNegativeStock,
    });
    return movement;
  }

  /**
   * Strict-режим: проверка `StockBalance.qty >= requestedQty` для
   * заранее выбранной ячейки. Используется
   * `applyMaterialIssueLineInTx` при `allowNegativeStock = false` и
   * `line.cellId` задан — мы НЕ ищем другой баланс при нехватке,
   * сразу бросаем insufficient.
   *
   * Если `StockBalance` для пары `(workshopNeed, cell)` ещё не
   * существует — трактуем это как `availableQty = 0` (никаких приёмок
   * в эту ячейку не было), и бросаем `MaterialStockInsufficientException`
   * с тем же контрактом, что `applyMovementInTx`.
   */
  private async assertCellBalanceSufficientInTx(
    tx: Prisma.TransactionClient,
    params: {
      workshopNeedId: string;
      warehouseId: string | null;
      cellId: string;
      requestedQty: Prisma.Decimal;
      unit: string;
      description: string;
    },
  ): Promise<void> {
    const balanceKey = buildStockBalanceKey(
      params.workshopNeedId,
      params.warehouseId,
      params.cellId,
    );
    const existing = await tx.stockBalance.findUnique({
      where: { balanceKey },
      select: { qty: true, warehouseId: true, cellId: true, unit: true },
    });
    const availableQty = existing?.qty ?? new Prisma.Decimal(0);
    if (availableQty.gte(params.requestedQty)) return;
    throw new MaterialStockInsufficientException(
      `Недостаточно остатка материала «${params.description}» (${params.unit}) в выбранной ячейке: запрошено ${params.requestedQty.toString()}, доступно ${availableQty.toString()}.`,
      {
        workshopNeedId: params.workshopNeedId,
        warehouseId: existing?.warehouseId ?? params.warehouseId,
        cellId: params.cellId,
        requestedQty: params.requestedQty.toString(),
        availableQty: availableQty.toString(),
        unit: params.unit,
        description: params.description,
      },
    );
  }

  // ===========================================================================
  // MATERIAL ISSUE RETURN → REVERSAL IN movements
  // ===========================================================================

  /**
   * Записывает зачисляющие движения по `MaterialIssueReturn` (возврат
   * проведённого расхода `MaterialIssue`). См.
   * `apps/api/src/modules/material-issues/material-issues.service.ts::returnPostedIssue`,
   * `prisma/schema.prisma::MaterialIssueReturn` /
   * `MaterialIssueReturnLine`,
   * `docs/current-state.md §«Material issue return»`.
   *
   * Контракт:
   *   - работает строго внутри переданного `tx`, новую транзакцию не
   *     открывает (вызывается из `MaterialIssuesService.returnPostedIssue`);
   *   - срабатывает только если `MaterialIssueReturn.status === POSTED`;
   *   - для каждой `MaterialIssueReturnLine` с `returnedQty > 0` и
   *     `workshopNeedId` создаёт `StockMovement` с `direction = IN`,
   *     `type = REVERSAL`, `sourceKey = MATERIAL_ISSUE_RETURN_LINE:<id>`.
   *     `applyMovementInTx` параллельно увеличивает `StockBalance.qty`
   *     и пересчитывает среднюю себестоимость.
   *   - идемпотентен: если движение по `sourceKey` уже существует,
   *     строка пропускается без побочных эффектов;
   *   - soft-skip строки без `workshopNeedId` / `unit` / `returnedQty <= 0`
   *     (защита от мусорных данных — без бросания ошибки, чтобы
   *     отдельная плохая строка не валила весь возврат).
   *
   * **Куда вернуть:** для каждой строки сначала ищем исходное OUT-
   * движение `MaterialIssueLine` (`sourceKey = MATERIAL_ISSUE_LINE:<id>`).
   * Если нашли — берём его `warehouseId` / `cellId` (чтобы возврат
   * лёг в ту же ячейку, откуда списывали) и его `unitCost` для
   * IN-движения (складская стоимость партии). Если оригинал не
   * найден (расход проводился до подключения склада или
   * без `workshopNeedId`):
   *   - если у строки возврата задан `cellId` — используем его
   *     (`warehouseId` подтянем через `Cell.warehouseId`);
   *   - иначе — `warehouseId = null`, `cellId = null` (no-location
   *     balance).
   *
   * Финансовая стоимость документа возврата (`MaterialIssueReturn.totalCost`)
   * живёт независимо от складской стоимости движения. Для UI / order
   * summary берётся `MaterialIssueReturn.totalCost` (snapshot
   * `MaterialIssueLine.unitCost`), а движение использует складскую
   * среднюю — те же два слоя, что и у `MaterialIssue` OUT.
   *
   * `IN`-движение никогда не блокируется флагом
   * `CompanySettings.allowNegativeMaterialStock` (этот hardening-гейт
   * относится только к OUT-движениям). Возврат разрешён всегда —
   * остаток только увеличивается.
   */
  async recordMaterialIssueReturnInTx(
    tx: Prisma.TransactionClient,
    materialIssueReturnId: string,
    employeeId?: string | null,
  ): Promise<StockMovement[]> {
    const ret = await tx.materialIssueReturn.findUnique({
      where: { id: materialIssueReturnId },
      include: {
        lines: {
          include: {
            materialIssueLine: {
              select: {
                id: true,
                workshopNeedId: true,
                description: true,
                materialRole: true,
                unit: true,
                cellId: true,
              },
            },
            workshopNeed: {
              select: {
                id: true,
                description: true,
                sourceName: true,
                materialRole: true,
                unit: true,
              },
            },
            cell: { select: { id: true, warehouseId: true } },
          },
        },
      },
    });
    if (!ret) return [];
    if (ret.status !== 'POSTED') return [];

    const reasonComment = (ret.reason ?? '').trim();
    const fallbackComment = 'Возврат по списанию материалов';
    const movements: StockMovement[] = [];
    for (const line of ret.lines) {
      const movement = await this.applyMaterialIssueReturnLineInTx(
        tx,
        ret.materialIssueId,
        line,
        reasonComment.length > 0 ? reasonComment : fallbackComment,
        employeeId ?? null,
      );
      if (movement) movements.push(movement);
    }
    return movements;
  }

  private async applyMaterialIssueReturnLineInTx(
    tx: Prisma.TransactionClient,
    materialIssueId: string,
    line: Prisma.MaterialIssueReturnLineGetPayload<{
      include: {
        materialIssueLine: {
          select: {
            id: true;
            workshopNeedId: true;
            description: true;
            materialRole: true;
            unit: true;
            cellId: true;
          };
        };
        workshopNeed: {
          select: {
            id: true;
            description: true;
            sourceName: true;
            materialRole: true;
            unit: true;
          };
        };
        cell: { select: { id: true; warehouseId: true } };
      };
    }>,
    comment: string,
    employeeId: string | null,
  ): Promise<StockMovement | null> {
    const sourceLine = line.materialIssueLine;
    const workshopNeedId = sourceLine?.workshopNeedId ?? line.workshopNeedId;
    if (!workshopNeedId) {
      this.logger.log(
        `event=stock.material_issue_return.skip reason=no_workshop_need ` +
          `materialIssueId=${materialIssueId} returnLineId=${line.id}`,
      );
      return null;
    }
    if (!line.unit || line.unit.length === 0) {
      this.logger.log(
        `event=stock.material_issue_return.skip reason=no_unit ` +
          `materialIssueId=${materialIssueId} returnLineId=${line.id}`,
      );
      return null;
    }
    const qty = line.returnedQty;
    if (!qty || qty.lessThanOrEqualTo(0)) {
      this.logger.log(
        `event=stock.material_issue_return.skip reason=non_positive_qty ` +
          `materialIssueId=${materialIssueId} returnLineId=${line.id}`,
      );
      return null;
    }

    const sourceKey = buildMaterialIssueReturnLineStockSourceKey(line.id);
    const existing = await this.findMovementBySourceKeyInTx(tx, sourceKey);
    if (existing) return existing;

    // Ищем исходное OUT-движение по `MaterialIssueLine`, чтобы
    // вернуть остаток в ту же ячейку и по той же складской цене,
    // которой он был списан. Если OUT не было (старый расход до
    // подключения склада / расход без workshopNeedId) — fallback на
    // `returnLine.cellId` или no-location balance.
    let warehouseId: string | null = null;
    let cellId: string | null = null;
    let stockUnitCost: Prisma.Decimal = line.unitCost;
    if (sourceLine) {
      const originalOutKey = buildMaterialIssueLineStockSourceKey(sourceLine.id);
      const originalOut = await this.findMovementBySourceKeyInTx(
        tx,
        originalOutKey,
      );
      if (originalOut) {
        warehouseId = originalOut.warehouseId ?? null;
        cellId = originalOut.cellId ?? null;
        stockUnitCost = originalOut.unitCost;
      } else if (line.cellId && line.cell) {
        cellId = line.cellId;
        warehouseId = line.cell.warehouseId ?? null;
      }
    } else if (line.cellId && line.cell) {
      cellId = line.cellId;
      warehouseId = line.cell.warehouseId ?? null;
    }

    const description =
      pickFirstNonEmpty([
        line.workshopNeed?.description,
        line.workshopNeed?.sourceName,
        line.description,
        sourceLine?.description,
      ]) ?? 'Материал';
    const materialRole =
      line.materialRole ??
      sourceLine?.materialRole ??
      line.workshopNeed?.materialRole ??
      null;

    const { movement } = await this.applyMovementInTx(tx, {
      workshopNeedId,
      warehouseId,
      cellId,
      description,
      materialRole,
      type: STOCK_MOVEMENT_TYPE.REVERSAL,
      direction: STOCK_MOVEMENT_DIRECTION.IN,
      qty,
      unit: line.unit,
      // Складская цена IN-движения: цена из исходного OUT, если он
      // был; иначе — документная цена из MaterialIssueReturnLine
      // (snapshot MaterialIssueLine.unitCost). Не клампим — `IN`
      // через `applyMovementInTx` пересчитывает среднюю и пишет
      // именно эту цену в `StockMovement.unitCost`.
      unitCost: stockUnitCost,
      sourceType: STOCK_MOVEMENT_SOURCE_KEY_PREFIX.MATERIAL_ISSUE_RETURN_LINE,
      sourceId: line.id,
      sourceKey,
      // Бизнес-привязку оставляем на исходный `MaterialIssue` /
      // `MaterialIssueLine`, чтобы фильтры журнала по
      // `materialIssueId` / `materialIssueLineId` показывали и
      // OUT, и REVERSAL IN рядом. ID самого `MaterialIssueReturn`
      // фигурирует только в `sourceId` / `sourceKey` (специальный
      // префикс выше).
      materialIssueId,
      materialIssueLineId: sourceLine?.id ?? null,
      comment,
      createdById: employeeId,
    });
    return movement;
  }

  // ===========================================================================
  // STOCK ADJUSTMENT (manual) → ADJUSTMENT IN/OUT movements
  // ===========================================================================

  /**
   * Ручная корректировка остатка материала
   * (`POST /api/stock/adjustments`, см.
   * `apps/api/src/modules/stock/stock.controller.ts`,
   * `apps/api/src/modules/stock/dto/create-stock-adjustment.dto.ts`,
   * UI — `/admin/warehouses?tab=balances`,
   * `docs/api.md §«26a.3 POST /api/stock/adjustments»`).
   *
   * Контракт:
   *   - открывает свою `prisma.$transaction(...)`;
   *   - корректирует существующий `StockBalance` по `stockBalanceId`
   *     (для MVP корректировка только существующего остатка — см. DTO);
   *   - пишет одно `StockMovement` с `type = ADJUSTMENT`,
   *     `direction = dto.direction`, идемпотентным
   *     `sourceKey = STOCK_ADJUSTMENT:<clientRequestId>`. Повторный
   *     submit с тем же `clientRequestId` возвращает существующее
   *     движение и не апдейтит `StockBalance` второй раз;
   *   - для `IN` использует `unitCost` из dto (или текущий
   *     `balance.unitCost`, или `0`); для `OUT` `unitCost` из dto
   *     игнорируется — `applyMovementInTx` берёт текущий
   *     `balance.unitCost` (`MaterialIssue.totalCost` при этом не
   *     меняется — корректировка живёт только в плоскости склада);
   *   - для `OUT` при `CompanySettings.allowNegativeMaterialStock = false`
   *     бросает 409 `MATERIAL_STOCK_INSUFFICIENT`, если остатка
   *     недостаточно. `IN` от флага не зависит. `PurchaseReceipt`
   *     reversal остаётся permissive — мы его не трогаем;
   *   - пишет audit `STOCK_ADJUSTMENT_CREATED` под
   *     `entityType = STOCK_MOVEMENT` в той же транзакции.
   */
  /**
   * Resolve эффективного `allowNegativeMaterialStock` для OUT-
   * корректировки `StockBalance`.
   *
   * Порядок разрешения (см.
   * `CompanySettingsService.getEffectiveMaterialStockSettingsForOrder`,
   * `docs/current-state.md §«Материалы и склад — division overrides»`):
   *   1. `StockBalance → WorkshopNeed.orderId`;
   *   2. если у заказа есть `companyDivisionId` и у division стоит
   *      override `allowNegativeMaterialStockOverride` — берём его;
   *   3. иначе — глобальный `CompanySettings.allowNegativeMaterialStock`
   *      (default `true`).
   *
   * Если `stockBalanceId` не найден / `WorkshopNeed` без заказа
   * (теоретически невозможно на production, но страхуемся) —
   * возвращаем глобальный флаг через
   * `CompanySettingsService.getAllowNegativeMaterialStock()`.
   */
  private async resolveAdjustmentAllowNegative(
    stockBalanceId: string,
  ): Promise<boolean> {
    const balance = await this.prisma.stockBalance.findUnique({
      where: { id: stockBalanceId },
      select: { workshopNeed: { select: { orderId: true } } },
    });
    const orderId = balance?.workshopNeed?.orderId ?? null;
    if (!orderId) {
      return this.companySettings.getAllowNegativeMaterialStock();
    }
    const effective =
      await this.companySettings.getEffectiveMaterialStockSettingsForOrder(
        orderId,
      );
    return effective.allowNegativeMaterialStock;
  }

  async createAdjustment(
    dto: CreateStockAdjustmentDto,
    employeeId: string | null | undefined,
  ): Promise<StockMovementListItem> {
    const qty = parseAdjustmentDecimal(dto.qty, 'qty');
    if (qty.lte(0)) {
      throw new BusinessException(
        'STOCK_MOVEMENT_QTY_INVALID',
        'Количество корректировки должно быть больше нуля.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      dto.direction !== STOCK_MOVEMENT_DIRECTION.IN &&
      dto.direction !== STOCK_MOVEMENT_DIRECTION.OUT
    ) {
      throw new BusinessException(
        'STOCK_MOVEMENT_DIRECTION_INVALID',
        'Недопустимое направление корректировки (ожидается IN или OUT).',
        HttpStatus.BAD_REQUEST,
      );
    }

    const dtoUnitCost =
      dto.unitCost !== undefined && dto.unitCost !== null
        ? parseAdjustmentDecimal(dto.unitCost, 'unitCost')
        : null;
    if (dtoUnitCost && dtoUnitCost.lt(0)) {
      throw new BusinessException(
        'STOCK_MOVEMENT_UNIT_COST_INVALID',
        'Цена корректировки не может быть отрицательной.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Hardening-флаг читаем ДО $transaction — это безопасный SELECT
    // (см. `MaterialIssuesService.post`). Для OUT эффективный флаг
    // учитывает per-division override
    // `CompanyDivision.allowNegativeMaterialStockOverride`, если у
    // остатка есть связанный заказ (`StockBalance.workshopNeed.orderId`).
    // При отсутствии заказа (старые foundation-балансы) / отсутствии
    // у заказа `companyDivisionId` — fallback на глобальный
    // `CompanySettings.allowNegativeMaterialStock`. IN-корректировки
    // от флага не зависят — ниже мы всё равно передаём `true` для IN.
    //
    // `PurchaseReceipt` cancel / REVERSAL OUT сознательно остаётся
    // permissive (см. `reversePurchaseReceiptInTx`) — корректировка
    // приёмки другой бизнес-сценарий.
    const allowNegativeStock = await this.resolveAdjustmentAllowNegative(
      dto.stockBalanceId,
    );

    const isIn = dto.direction === STOCK_MOVEMENT_DIRECTION.IN;
    const clientRequestId = dto.clientRequestId ?? randomUUID();
    const sourceKey = buildStockAdjustmentSourceKey(clientRequestId);

    const movement = await this.prisma.$transaction(async (tx) => {
      const existing = await this.findMovementBySourceKeyInTx(tx, sourceKey);
      if (existing) {
        // Идемпотентность: один `clientRequestId` → одно движение.
        // Не пишем audit повторно, не апдейтим `StockBalance`.
        return existing;
      }

      const balance = await tx.stockBalance.findUnique({
        where: { id: dto.stockBalanceId },
      });
      if (!balance) {
        throw new BusinessException(
          'STOCK_BALANCE_NOT_FOUND',
          'Остаток не найден.',
          HttpStatus.NOT_FOUND,
        );
      }

      const movementUnitCost = isIn
        ? (dtoUnitCost ?? balance.unitCost ?? new Prisma.Decimal(0))
        : new Prisma.Decimal(0);

      const { movement: created, balance: updated } =
        await this.applyMovementInTx(tx, {
          workshopNeedId: balance.workshopNeedId,
          warehouseId: balance.warehouseId,
          cellId: balance.cellId,
          description: balance.description,
          materialRole: balance.materialRole,
          type: STOCK_MOVEMENT_TYPE.ADJUSTMENT,
          direction: dto.direction as StockMovementDirection,
          qty,
          unit: balance.unit,
          unitCost: movementUnitCost,
          sourceType: STOCK_MOVEMENT_SOURCE_KEY_PREFIX.STOCK_ADJUSTMENT,
          sourceId: clientRequestId,
          sourceKey,
          comment: dto.comment,
          createdById: employeeId ?? null,
          // IN не зависит от флага; OUT уважает hardening-гейт
          // `CompanySettings.allowNegativeMaterialStock`. Если `false`
          // и нехватка — applyMovementInTx бросит 409, транзакция
          // откатится (audit и StockMovement не запишутся).
          allowNegativeStock: isIn ? true : allowNegativeStock,
        });

      await this.audit.log(
        {
          event: 'STOCK_ADJUSTMENT_CREATED',
          entityType: 'STOCK_MOVEMENT',
          entityId: created.id,
          employeeId: employeeId ?? null,
          payload: {
            stockMovementId: created.id,
            stockBalanceId: updated.id,
            workshopNeedId: created.workshopNeedId,
            warehouseId: created.warehouseId,
            cellId: created.cellId,
            direction: created.direction,
            qty: created.qty.toString(),
            unit: created.unit,
            unitCost: created.unitCost.toString(),
            totalCost: created.totalCost.toString(),
            balanceBeforeQty: created.balanceBeforeQty?.toString() ?? null,
            balanceAfterQty: created.balanceAfterQty?.toString() ?? null,
            comment: created.comment,
            employeeId: employeeId ?? null,
            sourceKey,
            timestamp: created.createdAt.toISOString(),
          } as Prisma.InputJsonValue,
        },
        tx,
      );

      return created;
    });

    this.logger.log(
      `event=stock.adjustment.create id=${movement.id} ` +
        `direction=${movement.direction} qty=${movement.qty.toString()} ` +
        `stockBalanceId=${dto.stockBalanceId} sourceKey=${sourceKey}`,
    );

    // Возвращаем item в shape `StockMovementListItem` — тот же, что
    // отдаёт `GET /api/stock/movements` (см. `toStockMovementListItem`).
    // `sourceKey` сознательно НЕ отдаём наружу.
    const detail = await this.prisma.stockMovement.findUniqueOrThrow({
      where: { id: movement.id },
      include: STOCK_MOVEMENT_LIST_INCLUDE,
    });
    return toStockMovementListItem(detail);
  }

  // ===========================================================================
  // STOCK TRANSFER (склад-в-склад / ячейка-в-ячейка)
  // ===========================================================================

  /**
   * Перемещение остатка `StockBalance` между складами / ячейками
   * (`POST /api/stock/transfers`, см.
   * `apps/api/src/modules/stock/stock.controller.ts`,
   * `apps/api/src/modules/stock/dto/create-stock-transfer.dto.ts`,
   * UI — `/admin/warehouses?tab=balances`, кнопка «Переместить»,
   * `docs/api.md §«26a.4 POST /api/stock/transfers»`).
   *
   * Контракт:
   *   - открывает свою `prisma.$transaction(...)`;
   *   - находит исходный `StockBalance` по `fromStockBalanceId` и
   *     достаёт `workshopNeedId`, `description`, `materialRole`, `unit`,
   *     `unitCost` — клиент эти поля не присылает;
   *   - проверяет, что `qty > 0` и `source.qty >= qty` (transfer всегда
   *     strict, `allowNegativeMaterialStock` НЕ используется);
   *   - при `toCellId` — `Cell.warehouseId` (с fallback на
   *     `toWarehouseId`) определяет destination warehouse, иначе
   *     `cellId = null`;
   *   - запрещает same-location transfer (404 / 409
   *     `STOCK_TRANSFER_SAME_LOCATION`);
   *   - пишет пару `StockMovement` `type = TRANSFER`:
   *     `direction = OUT` (sourceKey `STOCK_TRANSFER:<id>:OUT`) уменьшает
   *     исходный остаток, `direction = IN` (sourceKey
   *     `STOCK_TRANSFER:<id>:IN`) создаёт / увеличивает целевой
   *     `StockBalance`. IN использует `unitCost` исходного баланса —
   *     `applyMovementInTx` пересчитывает средневзвешенную цену
   *     назначения;
   *   - идемпотентен по `clientRequestId`: если оба ключа уже
   *     существуют, возвращает существующую пару и не апдейтит баланс
   *     повторно. Если найден только один — поднимает 409
   *     `STOCK_TRANSFER_INCONSISTENT_STATE` (структурная аномалия);
   *   - пишет audit `STOCK_TRANSFER_CREATED` под
   *     `entityType = STOCK_MOVEMENT` (`entityId = OUT.id`) в той же
   *     транзакции.
   *
   * Сознательная граница MVP: НЕ создаём отдельную модель `StockTransfer`,
   * НЕ дробим transfer (один OUT + один IN), НЕ влияет на
   * `MaterialIssue.totalCost` / `OrderSummary` / production cost —
   * transfer живёт строго в плоскости склада.
   */
  async createTransfer(
    dto: CreateStockTransferDto,
    employeeId: string | null | undefined,
  ): Promise<{
    transferId: string;
    outMovement: StockMovementListItem;
    inMovement: StockMovementListItem;
  }> {
    const qty = parseAdjustmentDecimal(dto.qty, 'qty');
    if (qty.lte(0)) {
      throw new BusinessException(
        'STOCK_MOVEMENT_QTY_INVALID',
        'Количество перемещения должно быть больше нуля.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const clientRequestId = dto.clientRequestId ?? randomUUID();
    const transferId = clientRequestId;
    const outSourceKey = buildStockTransferOutSourceKey(clientRequestId);
    const inSourceKey = buildStockTransferInSourceKey(clientRequestId);

    const { outMovementId, inMovementId } = await this.prisma.$transaction(
      async (tx) => {
        // ---- idempotency: оба ключа уже есть -------------------------------
        const existingOut = await this.findMovementBySourceKeyInTx(
          tx,
          outSourceKey,
        );
        const existingIn = await this.findMovementBySourceKeyInTx(
          tx,
          inSourceKey,
        );
        if (existingOut && existingIn) {
          return {
            outMovementId: existingOut.id,
            inMovementId: existingIn.id,
          };
        }
        if (existingOut || existingIn) {
          throw new BusinessException(
            'STOCK_TRANSFER_INCONSISTENT_STATE',
            'Перемещение находится в несогласованном состоянии (есть только OUT или только IN).',
            HttpStatus.CONFLICT,
          );
        }

        // ---- source ----------------------------------------------------------
        const source = await tx.stockBalance.findUnique({
          where: { id: dto.fromStockBalanceId },
        });
        if (!source) {
          throw new BusinessException(
            'STOCK_BALANCE_NOT_FOUND',
            'Исходный остаток не найден.',
            HttpStatus.NOT_FOUND,
          );
        }
        if (source.qty.lt(qty)) {
          throw new MaterialStockInsufficientException(
            `Недостаточно остатка материала «${source.description}» (${source.unit}): запрошено ${qty.toString()}, доступно ${source.qty.toString()}.`,
            {
              workshopNeedId: source.workshopNeedId,
              warehouseId: source.warehouseId ?? null,
              cellId: source.cellId ?? null,
              requestedQty: qty.toString(),
              availableQty: source.qty.toString(),
              unit: source.unit,
              description: source.description,
            },
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
              'STOCK_TRANSFER_CELL_NOT_FOUND',
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
            'STOCK_TRANSFER_SAME_LOCATION',
            'Источник и назначение перемещения совпадают.',
            HttpStatus.CONFLICT,
          );
        }

        // ---- OUT (списание из source) ---------------------------------------
        const sourceUnitCost = source.unitCost;
        const { movement: outMovement } = await this.applyMovementInTx(tx, {
          workshopNeedId: source.workshopNeedId,
          warehouseId: source.warehouseId,
          cellId: source.cellId,
          description: source.description,
          materialRole: source.materialRole,
          type: STOCK_MOVEMENT_TYPE.TRANSFER,
          direction: STOCK_MOVEMENT_DIRECTION.OUT,
          qty,
          unit: source.unit,
          unitCost: sourceUnitCost,
          sourceType: STOCK_MOVEMENT_SOURCE_KEY_PREFIX.STOCK_TRANSFER,
          sourceId: transferId,
          sourceKey: outSourceKey,
          comment: dto.comment,
          createdById: employeeId ?? null,
          // Transfer всегда strict — отрицательный остаток источника
          // запрещён независимо от `allowNegativeMaterialStock`.
          allowNegativeStock: false,
        });

        // ---- IN (зачисление в destination) ----------------------------------
        const { movement: inMovement } = await this.applyMovementInTx(tx, {
          workshopNeedId: source.workshopNeedId,
          warehouseId: destWarehouseId,
          cellId: destCellId,
          description: source.description,
          materialRole: source.materialRole,
          type: STOCK_MOVEMENT_TYPE.TRANSFER,
          direction: STOCK_MOVEMENT_DIRECTION.IN,
          qty,
          unit: source.unit,
          // IN использует `unitCost` исходного баланса —
          // применяется средневзвешенная по назначению.
          unitCost: sourceUnitCost,
          sourceType: STOCK_MOVEMENT_SOURCE_KEY_PREFIX.STOCK_TRANSFER,
          sourceId: transferId,
          sourceKey: inSourceKey,
          comment: dto.comment,
          createdById: employeeId ?? null,
        });

        // ---- audit ----------------------------------------------------------
        await this.audit.log(
          {
            event: 'STOCK_TRANSFER_CREATED',
            entityType: 'STOCK_MOVEMENT',
            entityId: outMovement.id,
            employeeId: employeeId ?? null,
            payload: {
              sourceType: STOCK_MOVEMENT_SOURCE_KEY_PREFIX.STOCK_TRANSFER,
              transferId,
              fromStockBalanceId: source.id,
              toStockBalanceId: inMovement.stockBalanceId,
              outMovementId: outMovement.id,
              inMovementId: inMovement.id,
              workshopNeedId: source.workshopNeedId,
              qty: qty.toString(),
              unit: source.unit,
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
      `event=stock.transfer.create transferId=${transferId} ` +
        `out=${outMovementId} in=${inMovementId} qty=${qty.toString()} ` +
        `fromStockBalanceId=${dto.fromStockBalanceId}`,
    );

    // Возвращаем пару движений в shape `StockMovementListItem` — тот же,
    // что отдаёт `GET /api/stock/movements`. `sourceKey` сознательно
    // не пробрасываем (`toStockMovementListItem` его вырезает).
    const [outDetail, inDetail] = await Promise.all([
      this.prisma.stockMovement.findUniqueOrThrow({
        where: { id: outMovementId },
        include: STOCK_MOVEMENT_LIST_INCLUDE,
      }),
      this.prisma.stockMovement.findUniqueOrThrow({
        where: { id: inMovementId },
        include: STOCK_MOVEMENT_LIST_INCLUDE,
      }),
    ]);

    return {
      transferId,
      outMovement: toStockMovementListItem(outDetail),
      inMovement: toStockMovementListItem(inDetail),
    };
  }
}

// ---------------------------------------------------------------------------
// helpers (file-private)
// ---------------------------------------------------------------------------

/**
 * Парсер `qty` / `unitCost` из тела `POST /api/stock/adjustments`.
 * DTO принимает строку или число, превращаем в `Prisma.Decimal` с
 * понятной 400-ошибкой при мусоре. Сами числовые ограничения
 * (положительность, неотрицательность цены) валидируются вызывающим.
 */
function parseAdjustmentDecimal(
  raw: string | number,
  field: 'qty' | 'unitCost',
): Prisma.Decimal {
  try {
    const value = typeof raw === 'number' ? raw : raw.trim();
    if (value === '' || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error('empty');
    }
    return new Prisma.Decimal(value);
  } catch {
    throw new BusinessException(
      'STOCK_MOVEMENT_VALUE_INVALID',
      `Поле «${field}» имеет некорректное числовое значение.`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * Возвращает первое непустое строковое значение или `null`.
 */
function pickFirstNonEmpty(
  values: ReadonlyArray<string | null | undefined>,
): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * Стоимость единицы для входящего движения по строке приёмки.
 *
 * Правила MVP (без конвертации валют, без отрицательных цен):
 *   - валюта пустая или `RUB` → берём `priceSnapshot`;
 *   - другая валюта (`USD`, `EUR`, ...) → `0` (конвертацию не делаем);
 *   - `priceSnapshot` отсутствует или отрицателен → `0`.
 */
/**
 * `StockMovement.comment` для OUT-движения по `MaterialIssue`.
 * Текст — человекочитаемый, попадает в журнал движений и бизнес-отчёты
 * (см. `docs/api.md §«Material issues»`).
 */
function buildMaterialIssueStockComment(source: string): string {
  if (source === 'AUTO_CUT_ISSUE') {
    return 'Автоматическое списание при выдаче кроя';
  }
  return 'Списание по документу расхода материалов';
}

function resolvePurchaseReceiptLineUnitCost(line: {
  priceSnapshot: Prisma.Decimal | null;
  currencySnapshot: string | null;
}): Prisma.Decimal {
  const ZERO = new Prisma.Decimal(0);
  const price = line.priceSnapshot;
  if (!price) return ZERO;
  if (price.lessThan(0)) return ZERO;
  const currency = (line.currencySnapshot ?? '').trim().toUpperCase();
  if (currency.length > 0 && currency !== 'RUB') return ZERO;
  return price;
}

// ---------------------------------------------------------------------------
// Read-only list shapes for `GET /api/stock/balances|movements`.
// ---------------------------------------------------------------------------

/**
 * Дефолт для пагинации read-only API. Совпадает с DTO-схемой
 * (`limit max 200`); вынесен в константу, чтобы DTO и сервис не
 * разъезжались.
 */
const DEFAULT_LIST_LIMIT = 50;

/**
 * Тонкий include для list `StockBalance`. Только поля, которые
 * попадают в response — без heavy relation-объектов (особенно
 * `workshopNeed.order` обрезан до `{ id, number }`).
 */
const STOCK_BALANCE_LIST_INCLUDE = {
  workshopNeed: {
    select: {
      id: true,
      orderId: true,
      description: true,
      sourceName: true,
      materialRole: true,
      order: { select: { id: true, number: true } },
    },
  },
  warehouse: { select: { id: true, name: true, code: true } },
  cell: { select: { id: true, code: true, qrCode: true } },
} as const satisfies Prisma.StockBalanceInclude;

const STOCK_MOVEMENT_LIST_INCLUDE = {
  workshopNeed: {
    select: {
      id: true,
      orderId: true,
      description: true,
      sourceName: true,
      materialRole: true,
      order: {
        select: {
          id: true,
          number: true,
          // Client management chain (см. `prisma/schema.prisma::Order.clientId`,
          // `model Client`). Read-only — журнал движений материалов
          // показывает заказчика в `/admin/warehouses?tab=movements`
          // (колонка «Заказчик»).
          client: { select: { id: true, name: true } },
        },
      },
    },
  },
  warehouse: { select: { id: true, name: true, code: true } },
  cell: { select: { id: true, code: true, qrCode: true } },
} as const satisfies Prisma.StockMovementInclude;

export interface StockBalanceListItem {
  id: string;
  balanceKey: string;
  workshopNeedId: string;
  orderId: string | null;
  orderNumber: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  cellId: string | null;
  cellCode: string | null;
  description: string;
  materialRole: string | null;
  unit: string;
  qty: string;
  unitCost: string;
  totalCost: string;
  lastMovementAt: string | null;
  updatedAt: string;
}

export interface StockMovementListItem {
  id: string;
  stockBalanceId: string | null;
  workshopNeedId: string;
  orderId: string | null;
  orderNumber: string | null;
  /** `Order.clientId` — управленческая привязка к карточке клиента. */
  clientId: string | null;
  /** `Client.name` — отображается в UI журнала движений склада. */
  clientName: string | null;
  type: string;
  direction: string;
  warehouseId: string | null;
  warehouseName: string | null;
  cellId: string | null;
  cellCode: string | null;
  qty: string;
  unit: string;
  unitCost: string;
  totalCost: string;
  balanceBeforeQty: string | null;
  balanceAfterQty: string | null;
  sourceType: string | null;
  sourceId: string | null;
  purchaseReceiptId: string | null;
  purchaseReceiptLineId: string | null;
  materialIssueId: string | null;
  materialIssueLineId: string | null;
  comment: string | null;
  createdById: string | null;
  createdAt: string;
}

type StockBalanceWithRels = Prisma.StockBalanceGetPayload<{
  include: typeof STOCK_BALANCE_LIST_INCLUDE;
}>;

type StockMovementWithRels = Prisma.StockMovementGetPayload<{
  include: typeof STOCK_MOVEMENT_LIST_INCLUDE;
}>;

function buildStockBalanceWhere(
  query: ListStockBalancesQuery,
): Prisma.StockBalanceWhereInput {
  const conditions: Prisma.StockBalanceWhereInput[] = [];

  if (query.workshopNeedId) {
    conditions.push({ workshopNeedId: query.workshopNeedId });
  }
  if (query.warehouseId) {
    conditions.push({ warehouseId: query.warehouseId });
  }
  if (query.cellId) {
    conditions.push({ cellId: query.cellId });
  }
  if (query.materialRole) {
    conditions.push({ materialRole: query.materialRole });
  }
  if (query.unit) {
    conditions.push({ unit: query.unit });
  }
  if (query.orderId) {
    // Через relation `workshopNeed.orderId`. Безопасно: workshopNeed —
    // обязательная связь у `StockBalance`.
    conditions.push({ workshopNeed: { orderId: query.orderId } });
  }
  if (query.q) {
    const q = query.q;
    conditions.push({
      OR: [
        { description: { contains: q, mode: 'insensitive' } },
        {
          workshopNeed: {
            description: { contains: q, mode: 'insensitive' },
          },
        },
        {
          workshopNeed: {
            sourceName: { contains: q, mode: 'insensitive' },
          },
        },
      ],
    });
  }
  // Mutually exclusive: схема Zod гарантирует, что максимум один из
  // флагов `true`, поэтому проверяем без приоритета.
  if (query.positiveOnly) {
    conditions.push({ qty: { gt: 0 } });
  }
  if (query.negativeOnly) {
    conditions.push({ qty: { lt: 0 } });
  }
  if (query.zeroOnly) {
    conditions.push({ qty: 0 });
  }

  return conditions.length === 0 ? {} : { AND: conditions };
}

function buildStockMovementWhere(
  query: ListStockMovementsQuery,
): Prisma.StockMovementWhereInput {
  const conditions: Prisma.StockMovementWhereInput[] = [];

  if (query.workshopNeedId) {
    conditions.push({ workshopNeedId: query.workshopNeedId });
  }
  if (query.stockBalanceId) {
    conditions.push({ stockBalanceId: query.stockBalanceId });
  }
  if (query.warehouseId) {
    conditions.push({ warehouseId: query.warehouseId });
  }
  if (query.cellId) {
    conditions.push({ cellId: query.cellId });
  }
  if (query.type) {
    conditions.push({ type: query.type });
  }
  if (query.direction) {
    conditions.push({ direction: query.direction });
  }
  if (query.sourceType) {
    conditions.push({ sourceType: query.sourceType });
  }
  if (query.sourceId) {
    conditions.push({ sourceId: query.sourceId });
  }
  if (query.purchaseReceiptId) {
    conditions.push({ purchaseReceiptId: query.purchaseReceiptId });
  }
  if (query.purchaseReceiptLineId) {
    conditions.push({ purchaseReceiptLineId: query.purchaseReceiptLineId });
  }
  if (query.materialIssueId) {
    conditions.push({ materialIssueId: query.materialIssueId });
  }
  if (query.materialIssueLineId) {
    conditions.push({ materialIssueLineId: query.materialIssueLineId });
  }
  if (query.orderId) {
    conditions.push({ workshopNeed: { orderId: query.orderId } });
  }
  if (query.from || query.to) {
    const range: Prisma.DateTimeFilter = {};
    if (query.from) range.gte = new Date(query.from);
    if (query.to) range.lte = new Date(query.to);
    conditions.push({ createdAt: range });
  }
  if (query.q) {
    conditions.push({
      comment: { contains: query.q, mode: 'insensitive' },
    });
  }

  return conditions.length === 0 ? {} : { AND: conditions };
}

function toStockBalanceListItem(
  row: StockBalanceWithRels,
): StockBalanceListItem {
  return {
    id: row.id,
    balanceKey: row.balanceKey,
    workshopNeedId: row.workshopNeedId,
    orderId: row.workshopNeed?.orderId ?? null,
    orderNumber: row.workshopNeed?.order?.number ?? null,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouse?.name ?? null,
    cellId: row.cellId,
    cellCode: row.cell?.code ?? null,
    description: row.description,
    materialRole: row.materialRole,
    unit: row.unit,
    qty: row.qty.toString(),
    unitCost: row.unitCost.toString(),
    totalCost: row.totalCost.toString(),
    lastMovementAt: row.lastMovementAt
      ? row.lastMovementAt.toISOString()
      : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toStockMovementListItem(
  row: StockMovementWithRels,
): StockMovementListItem {
  return {
    id: row.id,
    stockBalanceId: row.stockBalanceId,
    workshopNeedId: row.workshopNeedId,
    orderId: row.workshopNeed?.orderId ?? null,
    orderNumber: row.workshopNeed?.order?.number ?? null,
    clientId: row.workshopNeed?.order?.client?.id ?? null,
    clientName: row.workshopNeed?.order?.client?.name ?? null,
    type: row.type,
    direction: row.direction,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouse?.name ?? null,
    cellId: row.cellId,
    cellCode: row.cell?.code ?? null,
    qty: row.qty.toString(),
    unit: row.unit,
    unitCost: row.unitCost.toString(),
    totalCost: row.totalCost.toString(),
    balanceBeforeQty: row.balanceBeforeQty
      ? row.balanceBeforeQty.toString()
      : null,
    balanceAfterQty: row.balanceAfterQty
      ? row.balanceAfterQty.toString()
      : null,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    purchaseReceiptId: row.purchaseReceiptId,
    purchaseReceiptLineId: row.purchaseReceiptLineId,
    materialIssueId: row.materialIssueId,
    materialIssueLineId: row.materialIssueLineId,
    comment: row.comment,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    // Сознательно НЕ отдаём `sourceKey` — это внутренний идемпотентный
    // технический ключ (`PURCHASE_RECEIPT_LINE:<id>`,
    // `MATERIAL_ISSUE_LINE:<id>` и т.п.), не предназначенный для
    // публичного API.
  };
}
