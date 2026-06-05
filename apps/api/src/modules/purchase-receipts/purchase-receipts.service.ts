import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PURCHASE_ORDER_LINE_ACTIVE_STATUSES,
  PURCHASE_ORDER_RECEIVABLE_STATUSES,
  type PurchaseOrderLineStatus,
  type PurchaseOrderStatus,
} from '@sewing/shared/purchase-orders';
import {
  PURCHASE_RECEIPT_LINE_ACTIVE_STATUSES,
  type CancelPurchaseReceiptDto,
  type CreatePurchaseReceiptFromPurchaseOrderDto,
  type ListPurchaseReceiptsQuery,
  type PurchaseReceiptDetailDto,
  type PurchaseReceiptLineDto,
  type PurchaseReceiptListItemDto,
  type UpdatePurchaseReceiptLineDto,
} from '@sewing/shared/purchase-receipts';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  PurchaseOrderNotFoundException,
  PurchaseReceiptCellNotFoundException,
  PurchaseReceiptInvalidPurchaseOrderStatusException,
  PurchaseReceiptLineNotInOrderException,
  PurchaseReceiptLinesRequiredException,
  PurchaseReceiptNotDraftException,
  PurchaseReceiptNotEditableException,
  PurchaseReceiptNotFoundException,
  PurchaseReceiptOverReceiptException,
  PurchaseReceiptQtyRequiredException,
} from '../../common/errors.js';
import { StockService } from '../stock/stock.service.js';
import { PurchaseReceiptNumberService } from './purchase-receipt-number.service.js';

/**
 * Сервис «Приёмка поставок» (Этап 7А, см.
 * `docs/recon-soft-integration.md §«Этап 7А»`).
 *
 * Бизнес-логика:
 *   - PR создаётся ТОЛЬКО из `PurchaseOrder` через
 *     `createFromPurchaseOrder(...)`. Никаких «пустых» документов
 *     или приёмки без PO на MVP.
 *   - Принимать можно только PO в статусе
 *     `SENT`/`CONFIRMED`/`PARTIALLY_RECEIVED`. `DRAFT`/`CANCELLED`
 *     блокируются `PurchaseReceiptInvalidPurchaseOrderStatusException`.
 *   - Каждая строка приёмки фиксирует item-snapshot из строки PO
 *     (`itemNameSnapshot/...`/`orderedQtySnapshot`/`confirmedQtySnapshot`/
 *     `priceSnapshot`/`currencySnapshot`).
 *   - После создания/отмены PR backend пересчитывает статусы
 *     `PurchaseOrderLine` (`PARTIALLY_RECEIVED`/`RECEIVED`),
 *     заголовка `PurchaseOrder` и связанных `WorkshopNeed`.
 *
 * Сознательная граница MVP:
 *   - складские остатки ведутся только по `WorkshopNeed` через
 *     foundation `StockBalance` / `StockMovement` (см.
 *     `apps/api/src/modules/stock/stock.service.ts`); создание
 *     POSTED-приёмки пишет входящий `StockMovement` (`IN`,
 *     `type = PURCHASE_RECEIPT`), отмена — сторнирующий
 *     `REVERSAL` (`OUT`), но только если исходный IN существует;
 *   - НЕТ master-таблицы `MaterialStockLot` / FIFO/LIFO /
 *     отдельного `MaterialStock` / `FabricRoll` / `CellContent`
 *     (всё это вынесено в следующие итерации);
 *   - НЕТ перемещений между ячейками, НЕТ списания в крой со
 *     склада (`MaterialIssue` пока не уменьшает `StockBalance`);
 *   - НЕТ оплаты поставщику;
 *   - НЕТ новых ролей.
 */
@Injectable()
export class PurchaseReceiptsService {
  private readonly logger = new Logger(PurchaseReceiptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly numberService: PurchaseReceiptNumberService,
    private readonly stock: StockService,
  ) {}

  // ===========================================================================
  // LIST / GET
  // ===========================================================================

  async list(
    query: ListPurchaseReceiptsQuery,
  ): Promise<PurchaseReceiptListItemDto[]> {
    const where: Prisma.PurchaseReceiptWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.purchaseOrderId) where.purchaseOrderId = query.purchaseOrderId;
    if (query.customerOrderId) where.customerOrderId = query.customerOrderId;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.cellId) {
      where.lines = { some: { cellId: query.cellId } };
    }
    if (query.search && query.search.length > 0) {
      const s = query.search;
      where.OR = [
        { number: { contains: s, mode: 'insensitive' } },
        { supplierNameSnapshot: { contains: s, mode: 'insensitive' } },
        { comment: { contains: s, mode: 'insensitive' } },
        { purchaseOrder: { number: { contains: s, mode: 'insensitive' } } },
        { customerOrder: { number: { contains: s, mode: 'insensitive' } } },
      ];
    }

    const rows = await this.prisma.purchaseReceipt.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
      include: PURCHASE_RECEIPT_LIST_INCLUDE,
    });
    return rows.map((row) => this.toListItemDto(row));
  }

  async get(id: string): Promise<PurchaseReceiptDetailDto> {
    const row = await this.prisma.purchaseReceipt.findUnique({
      where: { id },
      include: PURCHASE_RECEIPT_DETAIL_INCLUDE,
    });
    if (!row) throw new PurchaseReceiptNotFoundException();
    return this.toDetailDto(row);
  }

  async listForPurchaseOrder(
    purchaseOrderId: string,
  ): Promise<PurchaseReceiptListItemDto[]> {
    return this.list({ purchaseOrderId });
  }

  async listForCustomerOrder(
    customerOrderId: string,
  ): Promise<PurchaseReceiptListItemDto[]> {
    return this.list({ customerOrderId });
  }

  // ===========================================================================
  // CREATE FROM PURCHASE ORDER
  // ===========================================================================

  async createFromPurchaseOrder(
    dto: CreatePurchaseReceiptFromPurchaseOrderDto,
    actorEmployeeId?: string | null,
  ): Promise<PurchaseReceiptDetailDto> {
    if (!dto.lines || dto.lines.length === 0) {
      throw new PurchaseReceiptLinesRequiredException();
    }

    // 1. Загружаем PO с строками и связанными потребностями.
    const purchaseOrder = await this.prisma.purchaseOrder.findUnique({
      where: { id: dto.purchaseOrderId },
      include: {
        supplier: true,
        customerOrder: { select: { id: true, number: true } },
        lines: {
          include: {
            workshopNeed: { select: { id: true, status: true } },
            supplierCatalogItem: { select: { id: true } },
          },
        },
      },
    });
    if (!purchaseOrder) throw new PurchaseOrderNotFoundException();

    if (
      !(PURCHASE_ORDER_RECEIVABLE_STATUSES as readonly string[]).includes(
        purchaseOrder.status,
      )
    ) {
      throw new PurchaseReceiptInvalidPurchaseOrderStatusException(
        purchaseOrder.status,
      );
    }

    const isDraft = dto.draft === true;

    // 2. Валидация строк приёмки.
    const lineById = new Map(purchaseOrder.lines.map((l) => [l.id, l]));
    for (const inputLine of dto.lines) {
      const poLine = lineById.get(inputLine.purchaseOrderLineId);
      if (!poLine) throw new PurchaseReceiptLineNotInOrderException();
      if (poLine.status === 'CANCELLED') {
        throw new PurchaseReceiptLineNotInOrderException();
      }
      // Гарантируем receivedQty > 0 (Zod-схема уже проверяет, но
      // оставляем backend-guard на случай server-to-server вызовов).
      const qty = new Prisma.Decimal(inputLine.receivedQty);
      if (qty.lessThanOrEqualTo(0)) {
        throw new PurchaseReceiptQtyRequiredException();
      }
    }

    // 2a. Защита от переприёмки — только для проводимого документа.
    // Черновик не двигает остатки, поэтому его лимиты проверяем при
    // проведении (`post`), а не сейчас.
    if (!isDraft) {
      await this.assertNoOverReceipt(
        this.prisma,
        (lineId) => lineById.get(lineId),
        dto.lines,
      );
    }

    // 3. Проверяем существование cellId (если переданы).
    const cellIds = Array.from(
      new Set(
        dto.lines
          .map((l) => l.cellId)
          .filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    );
    if (cellIds.length > 0) {
      const found = await this.prisma.cell.findMany({
        where: { id: { in: cellIds } },
        select: { id: true },
      });
      const foundIds = new Set(found.map((c) => c.id));
      for (const cellId of cellIds) {
        if (!foundIds.has(cellId)) {
          throw new PurchaseReceiptCellNotFoundException();
        }
      }
    }

    const supplier = purchaseOrder.supplier;
    const customerOrder = purchaseOrder.customerOrder;
    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();

    // 4. Создаём документ + строки + пересчитываем статусы.
    const created = await this.prisma.$transaction(async (tx) => {
      const number = await this.numberService.nextNumber(tx);
      const receipt = await tx.purchaseReceipt.create({
        data: {
          number,
          purchaseOrder: { connect: { id: purchaseOrder.id } },
          supplier: supplier ? { connect: { id: supplier.id } } : undefined,
          supplierNameSnapshot: purchaseOrder.supplierNameSnapshot,
          supplierPhoneSnapshot: purchaseOrder.supplierPhoneSnapshot,
          supplierWebsiteSnapshot: purchaseOrder.supplierWebsiteSnapshot,
          supplierAddressSnapshot: purchaseOrder.supplierAddressSnapshot,
          customerOrder: customerOrder
            ? { connect: { id: customerOrder.id } }
            : undefined,
          status: isDraft ? 'DRAFT' : 'POSTED',
          receivedAt,
          receivedBy: actorEmployeeId
            ? { connect: { id: actorEmployeeId } }
            : undefined,
          comment: dto.comment ?? null,
          lines: {
            create: dto.lines.map((inputLine) => {
              const poLine = lineById.get(inputLine.purchaseOrderLineId)!;
              const priceSnapshot =
                poLine.confirmedPrice ?? poLine.price ?? null;
              return {
                purchaseOrderLine: {
                  connect: { id: poLine.id },
                },
                workshopNeed: poLine.workshopNeedId
                  ? { connect: { id: poLine.workshopNeedId } }
                  : undefined,
                supplierCatalogItem: poLine.supplierCatalogItemId
                  ? { connect: { id: poLine.supplierCatalogItemId } }
                  : undefined,
                itemNameSnapshot: poLine.itemNameSnapshot,
                supplierArticleSnapshot: poLine.supplierArticleSnapshot,
                unitSnapshot: poLine.unitSnapshot,
                orderedQtySnapshot: poLine.qty,
                confirmedQtySnapshot: poLine.confirmedQty,
                priceSnapshot,
                currencySnapshot: poLine.currency,
                receivedQty: new Prisma.Decimal(inputLine.receivedQty),
                unit: poLine.unitSnapshot,
                batchNumber: inputLine.batchNumber ?? null,
                rollNumber: inputLine.rollNumber ?? null,
                shade: inputLine.shade ?? null,
                actualWidthCm: inputLine.actualWidthCm ?? null,
                actualDensityGsm: inputLine.actualDensityGsm ?? null,
                cell: inputLine.cellId
                  ? { connect: { id: inputLine.cellId } }
                  : undefined,
                locationNote: inputLine.locationNote ?? null,
                status: isDraft ? 'DRAFT' : 'POSTED',
                comment: inputLine.comment ?? null,
              };
            }),
          },
        },
      });

      const affectedPoLineIds = Array.from(
        new Set(dto.lines.map((l) => l.purchaseOrderLineId)),
      );
      const affectedNeedIds = Array.from(
        new Set(
          dto.lines
            .map((l) => lineById.get(l.purchaseOrderLineId)?.workshopNeedId)
            .filter((v): v is string => !!v),
        ),
      );

      // Черновик не проводится: статусы PO/потребности не трогаем,
      // склад не двигаем. Это всё произойдёт при `post(...)`.
      let stockMovementsCount = 0;
      if (!isDraft) {
        await this.recalcAfterChange(
          tx,
          purchaseOrder.id,
          affectedPoLineIds,
          affectedNeedIds,
        );

        // Foundation складского учёта: входящие движения по строкам
        // приёмки. Идём в той же транзакции, чтобы либо «приёмка +
        // остатки», либо «ничего». Метод сам soft-skip-ает строки без
        // `workshopNeedId` / `unit` / `receivedQty <= 0` и идемпотентен
        // по `StockMovement.sourceKey`.
        const stockMovements = await this.stock.recordPurchaseReceiptInTx(
          tx,
          receipt.id,
          actorEmployeeId ?? null,
        );
        stockMovementsCount = stockMovements.length;
      }

      await this.audit.log(
        {
          event: 'PURCHASE_RECEIPT_CREATED',
          entityType: 'PURCHASE_RECEIPT',
          entityId: receipt.id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            receiptId: receipt.id,
            receiptNumber: receipt.number,
            draft: isDraft,
            purchaseOrderId: purchaseOrder.id,
            purchaseOrderNumber: purchaseOrder.number,
            customerOrderId: customerOrder?.id ?? null,
            customerOrderNumber: customerOrder?.number ?? null,
            linesCount: dto.lines.length,
            cellIds,
            affectedPoLineIds,
            affectedWorkshopNeedIds: affectedNeedIds,
            stockMovementsCount,
          },
        },
        tx,
      );

      return receipt;
    });

    this.logger.log(
      `event=purchase_receipt.create id=${created.id} number=${created.number} ` +
        `status=${isDraft ? 'DRAFT' : 'POSTED'} ` +
        `purchaseOrderId=${purchaseOrder.id} linesCount=${dto.lines.length} ` +
        `cellIds=${cellIds.length}`,
    );

    return this.get(created.id);
  }

  // ===========================================================================
  // POST (провести черновик)
  // ===========================================================================

  /**
   * Проводит черновик приёмки: `DRAFT → POSTED`. Здесь же
   * проверяется лимит переприёмки (по актуальным остаткам PO),
   * пересчитываются статусы PO/потребности и пишутся складские
   * движения. Идемпотентность: повторный вызов на уже `POSTED`
   * вернёт документ как есть.
   */
  async post(
    id: string,
    actorEmployeeId?: string | null,
  ): Promise<PurchaseReceiptDetailDto> {
    const current = await this.prisma.purchaseReceipt.findUnique({
      where: { id },
      include: {
        purchaseOrder: { select: { id: true, status: true, number: true } },
        lines: {
          where: { status: { not: 'CANCELLED' } },
          include: {
            purchaseOrderLine: true,
          },
        },
      },
    });
    if (!current) throw new PurchaseReceiptNotFoundException();
    if (current.status === 'POSTED') {
      // Идемпотентность: уже проведён.
      return this.get(id);
    }
    if (current.status !== 'DRAFT') {
      throw new PurchaseReceiptNotDraftException(current.status);
    }

    // PO должен всё ещё допускать приёмку.
    if (
      !(PURCHASE_ORDER_RECEIVABLE_STATUSES as readonly string[]).includes(
        current.purchaseOrder.status,
      )
    ) {
      throw new PurchaseReceiptInvalidPurchaseOrderStatusException(
        current.purchaseOrder.status,
      );
    }

    // Проверяем лимит переприёмки по актуальным остаткам PO.
    const poLineById = new Map(
      current.lines
        .filter((l) => l.purchaseOrderLine)
        .map((l) => [l.purchaseOrderLine!.id, l.purchaseOrderLine!] as const),
    );
    const requested = current.lines
      .filter((l) => l.purchaseOrderLineId)
      .map((l) => ({
        purchaseOrderLineId: l.purchaseOrderLineId!,
        receivedQty: l.receivedQty.toString(),
      }));
    await this.assertNoOverReceipt(
      this.prisma,
      (lineId) => poLineById.get(lineId),
      requested,
      id,
    );

    const affectedPoLineIds = Array.from(
      new Set(
        current.lines
          .map((l) => l.purchaseOrderLineId)
          .filter((v): v is string => !!v),
      ),
    );
    const affectedNeedIds = Array.from(
      new Set(
        current.lines
          .map((l) => l.workshopNeedId)
          .filter((v): v is string => !!v),
      ),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseReceipt.update({
        where: { id },
        data: { status: 'POSTED' },
      });
      await tx.purchaseReceiptLine.updateMany({
        where: { purchaseReceiptId: id, status: 'DRAFT' },
        data: { status: 'POSTED' },
      });

      await this.recalcAfterChange(
        tx,
        current.purchaseOrderId,
        affectedPoLineIds,
        affectedNeedIds,
      );

      const stockMovements = await this.stock.recordPurchaseReceiptInTx(
        tx,
        id,
        actorEmployeeId ?? null,
      );

      await this.audit.log(
        {
          event: 'PURCHASE_RECEIPT_POSTED',
          entityType: 'PURCHASE_RECEIPT',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            receiptId: id,
            receiptNumber: current.number,
            purchaseOrderId: current.purchaseOrderId,
            affectedPoLineIds,
            affectedWorkshopNeedIds: affectedNeedIds,
            stockMovementsCount: stockMovements.length,
          },
        },
        tx,
      );
    });

    this.logger.log(
      `event=purchase_receipt.post id=${id} number=${current.number} ` +
        `purchaseOrderId=${current.purchaseOrderId}`,
    );

    return this.get(id);
  }

  // ===========================================================================
  // UPDATE LINE (правка строки приёмки)
  // ===========================================================================

  /**
   * Правка строки приёмки. Что можно менять — зависит от статуса
   * документа:
   *   - `DRAFT`  — любое поле, включая `receivedQty` и `cellId`
   *     (склад ещё не тронут);
   *   - `POSTED` — только нескладские метаданные. Правка
   *     `receivedQty`/`cellId` запрещена (`PurchaseReceiptNotEditableException`),
   *     иначе разъедется с уже записанным `StockMovement`.
   *   - `CANCELLED` — нельзя редактировать вовсе.
   */
  async updateLine(
    id: string,
    lineId: string,
    dto: UpdatePurchaseReceiptLineDto,
    actorEmployeeId?: string | null,
  ): Promise<PurchaseReceiptDetailDto> {
    const receipt = await this.prisma.purchaseReceipt.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!receipt) throw new PurchaseReceiptNotFoundException();
    if (receipt.status === 'CANCELLED') {
      throw new PurchaseReceiptNotEditableException(
        'Документ приёмки отменён — редактировать строки нельзя.',
      );
    }

    const line = await this.prisma.purchaseReceiptLine.findUnique({
      where: { id: lineId },
    });
    if (!line || line.purchaseReceiptId !== id) {
      throw new PurchaseReceiptLineNotInOrderException();
    }
    if (line.status === 'CANCELLED') {
      throw new PurchaseReceiptNotEditableException(
        'Строка приёмки отменена — редактировать её нельзя.',
      );
    }

    const isDraft = receipt.status === 'DRAFT';
    const touchesStock =
      dto.receivedQty !== undefined || dto.cellId !== undefined;
    if (!isDraft && touchesStock) {
      throw new PurchaseReceiptNotEditableException(
        'У проведённой приёмки нельзя менять количество и ячейку — они уже отражены на складе. Отмените приёмку и оформите заново.',
      );
    }

    // Проверяем существование ячейки (если меняется на конкретную).
    if (dto.cellId) {
      const cell = await this.prisma.cell.findUnique({
        where: { id: dto.cellId },
        select: { id: true },
      });
      if (!cell) throw new PurchaseReceiptCellNotFoundException();
    }

    const data: Prisma.PurchaseReceiptLineUpdateInput = {};
    const changedFields: string[] = [];

    if (dto.receivedQty !== undefined) {
      data.receivedQty = new Prisma.Decimal(dto.receivedQty);
      changedFields.push('receivedQty');
    }
    if (dto.cellId !== undefined) {
      data.cell =
        dto.cellId === null
          ? { disconnect: true }
          : { connect: { id: dto.cellId } };
      changedFields.push('cellId');
    }
    if (dto.batchNumber !== undefined) {
      data.batchNumber = dto.batchNumber;
      changedFields.push('batchNumber');
    }
    if (dto.rollNumber !== undefined) {
      data.rollNumber = dto.rollNumber;
      changedFields.push('rollNumber');
    }
    if (dto.shade !== undefined) {
      data.shade = dto.shade;
      changedFields.push('shade');
    }
    if (dto.actualWidthCm !== undefined) {
      data.actualWidthCm = dto.actualWidthCm;
      changedFields.push('actualWidthCm');
    }
    if (dto.actualDensityGsm !== undefined) {
      data.actualDensityGsm = dto.actualDensityGsm;
      changedFields.push('actualDensityGsm');
    }
    if (dto.locationNote !== undefined) {
      data.locationNote = dto.locationNote;
      changedFields.push('locationNote');
    }
    if (dto.comment !== undefined) {
      data.comment = dto.comment;
      changedFields.push('comment');
    }

    if (Object.keys(data).length === 0) return this.get(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseReceiptLine.update({ where: { id: lineId }, data });
      await this.audit.log(
        {
          event: 'PURCHASE_RECEIPT_LINE_UPDATED',
          entityType: 'PURCHASE_RECEIPT',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: { lineId, status: receipt.status, changedFields },
        },
        tx,
      );
    });

    return this.get(id);
  }

  /**
   * Бросает `PurchaseReceiptOverReceiptException`, если по какой-либо
   * строке PO суммарное `Σ receivedQty` (уже проведённое по другим
   * приёмкам + запрашиваемое сейчас) превысит цель `confirmedQty ?? qty`.
   *
   * `excludeReceiptId` исключает строки этого же документа из
   * «уже проведённого» — нужно при `post`, чтобы черновик не считал
   * сам себя.
   */
  private async assertNoOverReceipt(
    db: Prisma.TransactionClient,
    getPoLine: (id: string) =>
      | {
          qty: Prisma.Decimal;
          confirmedQty: Prisma.Decimal | null;
          itemNameSnapshot: string;
          unitSnapshot: string;
        }
      | undefined,
    requested: { purchaseOrderLineId: string; receivedQty: string }[],
    excludeReceiptId?: string,
  ): Promise<void> {
    // Суммируем запрашиваемое по строке PO.
    const requestedByPoLine = new Map<string, Prisma.Decimal>();
    for (const r of requested) {
      const prev =
        requestedByPoLine.get(r.purchaseOrderLineId) ?? new Prisma.Decimal(0);
      requestedByPoLine.set(
        r.purchaseOrderLineId,
        prev.add(new Prisma.Decimal(r.receivedQty)),
      );
    }

    const poLineIds = Array.from(requestedByPoLine.keys());
    if (poLineIds.length === 0) return;

    // Уже проведённое (POSTED) по этим строкам PO, кроме excludeReceiptId.
    const existing = await db.purchaseReceiptLine.groupBy({
      by: ['purchaseOrderLineId'],
      where: {
        purchaseOrderLineId: { in: poLineIds },
        status: { in: PURCHASE_RECEIPT_LINE_ACTIVE_STATUSES as string[] },
        ...(excludeReceiptId
          ? { purchaseReceiptId: { not: excludeReceiptId } }
          : {}),
      },
      _sum: { receivedQty: true },
    });
    const alreadyByPoLine = new Map<string, Prisma.Decimal>();
    for (const row of existing) {
      if (!row.purchaseOrderLineId) continue;
      alreadyByPoLine.set(
        row.purchaseOrderLineId,
        row._sum.receivedQty ?? new Prisma.Decimal(0),
      );
    }

    for (const [poLineId, requestedQty] of requestedByPoLine) {
      const poLine = getPoLine(poLineId);
      if (!poLine) continue;
      const target = poLine.confirmedQty ?? poLine.qty;
      const already = alreadyByPoLine.get(poLineId) ?? new Prisma.Decimal(0);
      const total = already.add(requestedQty);
      if (total.greaterThan(target)) {
        const remaining = target.minus(already);
        const remainingStr = remaining.lessThan(0)
          ? '0'
          : remaining.toString();
        throw new PurchaseReceiptOverReceiptException(
          poLine.itemNameSnapshot,
          remainingStr,
          poLine.unitSnapshot,
        );
      }
    }
  }

  // ===========================================================================
  // CANCEL
  // ===========================================================================

  async cancel(
    id: string,
    dto: CancelPurchaseReceiptDto,
    actorEmployeeId?: string | null,
  ): Promise<PurchaseReceiptDetailDto> {
    const current = await this.prisma.purchaseReceipt.findUnique({
      where: { id },
      include: {
        lines: {
          select: {
            id: true,
            status: true,
            purchaseOrderLineId: true,
            workshopNeedId: true,
          },
        },
      },
    });
    if (!current) throw new PurchaseReceiptNotFoundException();

    if (current.status === 'CANCELLED') {
      // Идемпотентность: повторная отмена не считается ошибкой.
      return this.get(id);
    }

    const now = new Date();
    const affectedPoLineIds = Array.from(
      new Set(
        current.lines
          .map((l) => l.purchaseOrderLineId)
          .filter((v): v is string => !!v),
      ),
    );
    const affectedNeedIds = Array.from(
      new Set(
        current.lines
          .map((l) => l.workshopNeedId)
          .filter((v): v is string => !!v),
      ),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseReceipt.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          // Если до отмены комментарий не заполнен и пришла причина —
          // сохраняем её, чтобы менеджер позже видел контекст. Если
          // комментарий уже был — не затираем.
          ...(dto.reason && !current.comment ? { comment: dto.reason } : {}),
        },
      });
      await tx.purchaseReceiptLine.updateMany({
        where: {
          purchaseReceiptId: id,
          status: { not: 'CANCELLED' },
        },
        data: { status: 'CANCELLED' },
      });

      await this.recalcAfterChange(
        tx,
        current.purchaseOrderId,
        affectedPoLineIds,
        affectedNeedIds,
      );

      // Foundation складского учёта: сторнирующие OUT-движения по
      // строкам приёмки. Метод сам пропускает строки, у которых не
      // было исходного IN (старые приёмки до подключения склада), и
      // идемпотентен по `sourceKey =
      // PURCHASE_RECEIPT_LINE_CANCEL:<lineId>`.
      const reversalMovements = await this.stock.reversePurchaseReceiptInTx(
        tx,
        id,
        actorEmployeeId ?? null,
      );

      await this.audit.log(
        {
          event: 'PURCHASE_RECEIPT_CANCELLED',
          entityType: 'PURCHASE_RECEIPT',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            receiptId: id,
            receiptNumber: current.number,
            previousStatus: current.status,
            cancelledAt: now.toISOString(),
            reason: dto.reason ?? null,
            purchaseOrderId: current.purchaseOrderId,
            affectedPoLineIds,
            affectedWorkshopNeedIds: affectedNeedIds,
            stockReversalsCount: reversalMovements.length,
          },
        },
        tx,
      );
    });

    return this.get(id);
  }

  // ===========================================================================
  // INTERNAL: пересчёт статусов
  // ===========================================================================

  /**
   * Универсальный пересчёт после создания / отмены приёмки. Делается
   * ВНУТРИ транзакции.
   *
   * Алгоритм:
   *   1. Для каждой `PurchaseOrderLine` суммируем `receivedQty` по
   *      её активным `PurchaseReceiptLine` (status = POSTED).
   *      - sum >= target → `RECEIVED`;
   *      - sum > 0       → `PARTIALLY_RECEIVED`;
   *      - sum = 0       → восстанавливаем «допроходной» статус
   *        (`SENT` / `CONFIRMED`). Если строка была `CANCELLED` —
   *        не трогаем.
   *      - target = `confirmedQty ?? qty`.
   *   2. Для заголовка PO: смотрим только активные (не CANCELLED)
   *      строки.
   *      - если активных нет — оставляем как есть (corner case);
   *      - все RECEIVED → PO.status = `RECEIVED`;
   *      - есть хотя бы одна `PARTIALLY_RECEIVED` или `RECEIVED`
   *        (но не все) → PO.status = `PARTIALLY_RECEIVED`;
   *      - иначе → откат к `SENT`/`CONFIRMED` в зависимости от того,
   *        был ли `confirmedAt` (лучше бережно хранить «уже
   *        подтверждённый» статус).
   *      - DRAFT мы сюда не возвращаем — приёмка из DRAFT в принципе
   *        невозможна.
   *   3. Для каждого `WorkshopNeed`: смотрим активные строки PO по
   *      этой потребности.
   *      - все строки PO в `RECEIVED` → need.status = `RECEIVED`;
   *      - есть хотя бы одна `PARTIALLY_RECEIVED`/`RECEIVED` → need
   *        = `PARTIALLY_RECEIVED`;
   *      - иначе восстанавливаем `ORDERED`/`PURCHASE_PLANNED` —
   *        если активных строк PO нет, оставляем как есть (этим
   *        занимается `PurchaseOrdersService.cancel`).
   *      - `CANCELLED` потребности не трогаем.
   */
  private async recalcAfterChange(
    tx: Prisma.TransactionClient,
    purchaseOrderId: string,
    poLineIds: string[],
    workshopNeedIds: string[],
  ): Promise<void> {
    // «До приёмки» статус, к которому откатываемся при полной отмене.
    // Если PO когда-либо подтверждался (`confirmedAt`) — это
    // `CONFIRMED`, иначе `SENT`. Считаем один раз и переиспользуем и
    // для строк, и для заголовка, чтобы они не разъезжались.
    const poConfirm = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      select: { confirmedAt: true },
    });
    const fallbackStatus: PurchaseOrderStatus = poConfirm?.confirmedAt
      ? 'CONFIRMED'
      : 'SENT';

    // 1. Пересчёт строк PO.
    if (poLineIds.length > 0) {
      const poLines = await tx.purchaseOrderLine.findMany({
        where: { id: { in: poLineIds } },
      });
      for (const line of poLines) {
        if (line.status === 'CANCELLED') continue;
        const newStatus = await this.computePoLineStatus(
          tx,
          line,
          fallbackStatus,
        );
        if (newStatus !== line.status) {
          await tx.purchaseOrderLine.update({
            where: { id: line.id },
            data: { status: newStatus },
          });
        }
      }
    }

    // 2. Пересчёт заголовка PO.
    const po = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      select: {
        id: true,
        status: true,
        confirmedAt: true,
        lines: { select: { id: true, status: true } },
      },
    });
    if (po && po.status !== 'CANCELLED') {
      const activeLines = po.lines.filter((l) => l.status !== 'CANCELLED');
      let newPoStatus: PurchaseOrderStatus | null = null;
      if (activeLines.length === 0) {
        newPoStatus = null; // corner case: оставляем как есть
      } else if (activeLines.every((l) => l.status === 'RECEIVED')) {
        newPoStatus = 'RECEIVED';
      } else if (
        activeLines.some(
          (l) =>
            l.status === 'PARTIALLY_RECEIVED' || l.status === 'RECEIVED',
        )
      ) {
        newPoStatus = 'PARTIALLY_RECEIVED';
      } else {
        // Все активные строки до `SENT`/`CONFIRMED` — это случай
        // полной отмены приёмки. Возвращаем PO в безопасное «до
        // приёмки» состояние.
        newPoStatus = po.confirmedAt ? 'CONFIRMED' : 'SENT';
      }
      if (newPoStatus && newPoStatus !== po.status) {
        await tx.purchaseOrder.update({
          where: { id: po.id },
          data: { status: newPoStatus },
        });
      }
    }

    // 3. Пересчёт WorkshopNeed.
    for (const needId of workshopNeedIds) {
      const need = await tx.workshopNeed.findUnique({
        where: { id: needId },
        select: { id: true, status: true },
      });
      if (!need) continue;
      if (need.status === 'CANCELLED') continue;

      const activePoLines = await tx.purchaseOrderLine.findMany({
        where: {
          workshopNeedId: needId,
          status: {
            in: PURCHASE_ORDER_LINE_ACTIVE_STATUSES as string[],
          },
        },
        select: { status: true },
      });
      if (activePoLines.length === 0) {
        // Активных строк PO нет — за состояние отвечает
        // `PurchaseOrdersService.cancel` (он сам возвращает в
        // `PURCHASE_PLANNED`). Ничего не делаем.
        continue;
      }

      let newNeedStatus: string | null = null;
      if (activePoLines.every((l) => l.status === 'RECEIVED')) {
        newNeedStatus = 'RECEIVED';
      } else if (
        activePoLines.some(
          (l) =>
            l.status === 'PARTIALLY_RECEIVED' || l.status === 'RECEIVED',
        )
      ) {
        newNeedStatus = 'PARTIALLY_RECEIVED';
      } else {
        // Все активные строки PO откатились к SENT/CONFIRMED — тогда
        // потребность тоже возвращается к ORDERED.
        newNeedStatus = 'ORDERED';
      }
      if (newNeedStatus && newNeedStatus !== need.status) {
        await tx.workshopNeed.update({
          where: { id: need.id },
          data: { status: newNeedStatus },
        });
      }
    }
  }

  private async computePoLineStatus(
    tx: Prisma.TransactionClient,
    line: {
      id: string;
      status: string;
      qty: Prisma.Decimal;
      confirmedQty: Prisma.Decimal | null;
    },
    fallbackStatus: PurchaseOrderStatus,
  ): Promise<PurchaseOrderLineStatus | string> {
    const target = line.confirmedQty ?? line.qty;
    const sum = await tx.purchaseReceiptLine.aggregate({
      where: {
        purchaseOrderLineId: line.id,
        status: { in: PURCHASE_RECEIPT_LINE_ACTIVE_STATUSES as string[] },
      },
      _sum: { receivedQty: true },
    });
    const received = sum._sum.receivedQty ?? new Prisma.Decimal(0);
    if (received.lessThanOrEqualTo(0)) {
      // Откат к «до приёмки». Восстанавливаем тот же статус, что и
      // заголовок PO (`fallbackStatus`): `CONFIRMED`, если PO был
      // подтверждён, иначе `SENT`. Так строка и шапка не разъезжаются.
      if (
        line.status === 'PARTIALLY_RECEIVED' ||
        line.status === 'RECEIVED'
      ) {
        return fallbackStatus;
      }
      return line.status;
    }
    if (received.greaterThanOrEqualTo(target)) {
      return 'RECEIVED';
    }
    return 'PARTIALLY_RECEIVED';
  }

  // ===========================================================================
  // MAPPERS
  // ===========================================================================

  private toListItemDto(
    row: Prisma.PurchaseReceiptGetPayload<{
      include: typeof PURCHASE_RECEIPT_LIST_INCLUDE;
    }>,
  ): PurchaseReceiptListItemDto {
    return {
      id: row.id,
      number: row.number,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderNumber: row.purchaseOrder?.number ?? '',
      supplierId: row.supplierId,
      supplierNameSnapshot: row.supplierNameSnapshot,
      customerOrderId: row.customerOrderId,
      customerOrderNumber: row.customerOrder?.number ?? null,
      status: row.status,
      receivedAt: row.receivedAt.toISOString(),
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      receivedById: row.receivedById,
      receivedByName: row.receivedBy?.fullName ?? null,
      linesCount: row._count.lines,
      totalReceivedQty: this.computeTotalReceivedQty(row.lines),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toDetailDto(
    row: Prisma.PurchaseReceiptGetPayload<{
      include: typeof PURCHASE_RECEIPT_DETAIL_INCLUDE;
    }>,
  ): PurchaseReceiptDetailDto {
    return {
      id: row.id,
      number: row.number,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderNumber: row.purchaseOrder?.number ?? '',
      supplierId: row.supplierId,
      supplierNameSnapshot: row.supplierNameSnapshot,
      customerOrderId: row.customerOrderId,
      customerOrderNumber: row.customerOrder?.number ?? null,
      status: row.status,
      receivedAt: row.receivedAt.toISOString(),
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      linesCount: row.lines.length,
      totalReceivedQty: this.computeTotalReceivedQty(row.lines),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      supplierPhoneSnapshot: row.supplierPhoneSnapshot,
      supplierWebsiteSnapshot: row.supplierWebsiteSnapshot,
      supplierAddressSnapshot: row.supplierAddressSnapshot,
      comment: row.comment,
      receivedById: row.receivedById,
      receivedByName: row.receivedBy?.fullName ?? null,
      lines: row.lines.map((l) => this.lineToDto(l)),
    };
  }

  private lineToDto(
    l: Prisma.PurchaseReceiptLineGetPayload<{
      include: {
        cell: {
          include: {
            warehouse: { select: { id: true; name: true } };
            line: { select: { id: true; code: true } };
          };
        };
      };
    }>,
  ): PurchaseReceiptLineDto {
    return {
      id: l.id,
      purchaseOrderLineId: l.purchaseOrderLineId,
      workshopNeedId: l.workshopNeedId,
      supplierCatalogItemId: l.supplierCatalogItemId,
      itemNameSnapshot: l.itemNameSnapshot,
      supplierArticleSnapshot: l.supplierArticleSnapshot,
      unitSnapshot: l.unitSnapshot,
      orderedQtySnapshot: l.orderedQtySnapshot
        ? l.orderedQtySnapshot.toString()
        : null,
      confirmedQtySnapshot: l.confirmedQtySnapshot
        ? l.confirmedQtySnapshot.toString()
        : null,
      priceSnapshot: l.priceSnapshot ? l.priceSnapshot.toString() : null,
      currencySnapshot: l.currencySnapshot,
      receivedQty: l.receivedQty.toString(),
      unit: l.unit,
      batchNumber: l.batchNumber,
      rollNumber: l.rollNumber,
      shade: l.shade,
      actualWidthCm: l.actualWidthCm,
      actualDensityGsm: l.actualDensityGsm,
      cellId: l.cellId,
      cellCode: l.cell?.code ?? null,
      warehouseName: l.cell?.warehouse?.name ?? null,
      lineName: l.cell?.line?.code ?? null,
      locationNote: l.locationNote,
      status: l.status,
      comment: l.comment,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    };
  }

  /**
   * Σ receivedQty по активным строкам приёмки. Возвращаем как строку
   * для консистентности с DTO-форматом «Decimal как строка». Если ни
   * одной активной строки нет — `null` (документ полностью отменён).
   */
  private computeTotalReceivedQty(
    lines: { receivedQty: Prisma.Decimal; status: string }[],
  ): string | null {
    let total = new Prisma.Decimal(0);
    let hasActive = false;
    for (const l of lines) {
      if (l.status === 'CANCELLED') continue;
      hasActive = true;
      total = total.add(l.receivedQty);
    }
    if (!hasActive) return null;
    return total.toString();
  }
}

// ---------------------------------------------------------------------------
// Includes (источник истины для list/get)
// ---------------------------------------------------------------------------

const PURCHASE_RECEIPT_LIST_INCLUDE = {
  purchaseOrder: { select: { id: true, number: true } },
  customerOrder: { select: { id: true, number: true } },
  receivedBy: { select: { id: true, fullName: true } },
  lines: { select: { id: true, receivedQty: true, status: true } },
  _count: { select: { lines: true } },
} as const satisfies Prisma.PurchaseReceiptInclude;

const PURCHASE_RECEIPT_DETAIL_INCLUDE = {
  purchaseOrder: { select: { id: true, number: true } },
  customerOrder: { select: { id: true, number: true } },
  receivedBy: { select: { id: true, fullName: true } },
  lines: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      cell: {
        include: {
          warehouse: { select: { id: true, name: true } },
          line: { select: { id: true, code: true } },
        },
      },
    },
  },
} as const satisfies Prisma.PurchaseReceiptInclude;
