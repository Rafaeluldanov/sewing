import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PURCHASE_ORDER_LINE_ACTIVE_STATUSES,
  type ConfirmPurchaseOrderDto,
  type CreatePurchaseOrderFromNeedsDto,
  type ListPurchaseOrdersQuery,
  type PurchaseOrderDetailDto,
  type PurchaseOrderLineDto,
  type PurchaseOrderListItemDto,
  type UpdatePurchaseOrderDto,
  type UpdatePurchaseOrderLineDto,
} from '@sewing/shared/purchase-orders';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  PurchaseOrderHasReceiptsException,
  PurchaseOrderInvalidStatusTransitionException,
  PurchaseOrderLineNotFoundException,
  PurchaseOrderNeedAlreadyOrderedException,
  PurchaseOrderNeedPurchaseQtyRequiredException,
  PurchaseOrderNeedsDifferentOrdersException,
  PurchaseOrderNeedsDifferentSuppliersException,
  PurchaseOrderNeedsRequiredException,
  PurchaseOrderNeedsSupplierRequiredException,
  PurchaseOrderNotFoundException,
  SupplierInactiveException,
} from '../../common/errors.js';
import { PurchaseOrderNumberService } from './purchase-order-number.service.js';

/**
 * Сервис «Заказы поставщикам» (Этап 6А, см.
 * `docs/recon-soft-integration.md §«Этап 6А»`).
 *
 * Бизнес-логика:
 *   - PO создаётся ТОЛЬКО из `WorkshopNeed` через
 *     `createFromNeeds(...)`. Никаких «пустых» документов на MVP.
 *   - В момент создания фиксируем supplier-snapshot и item-snapshots
 *     по каждой строке, а связанным `WorkshopNeed` ставим статус
 *     `ORDERED`.
 *   - Переходы статусов: `DRAFT → SENT → CONFIRMED`, любой → `CANCELLED`
 *     (кроме самого `CANCELLED`). Откаты запрещены.
 *   - При `cancel(...)` строки переводятся в `CANCELLED`, а связанные
 *     `WorkshopNeed` возвращаются в `PURCHASE_PLANNED`, если по ним
 *     больше нет активных строк PO (`DRAFT`/`SENT`/`CONFIRMED`).
 *
 * Этот модуль НЕ ведёт приёмку, НЕ создаёт `MaterialReceipt` /
 * `FabricRoll`, НЕ связан с `Warehouse` / `Cell` / `CellContent` —
 * это сознательная граница MVP (см. ТЗ Этапа 6А).
 */
@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly numberService: PurchaseOrderNumberService,
  ) {}

  // ===========================================================================
  // LIST / GET
  // ===========================================================================

  async list(
    query: ListPurchaseOrdersQuery,
  ): Promise<PurchaseOrderListItemDto[]> {
    const where: Prisma.PurchaseOrderWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.customerOrderId) where.customerOrderId = query.customerOrderId;
    if (query.search && query.search.length > 0) {
      const s = query.search;
      where.OR = [
        { number: { contains: s, mode: 'insensitive' } },
        { supplierNameSnapshot: { contains: s, mode: 'insensitive' } },
        { comment: { contains: s, mode: 'insensitive' } },
        { customerOrder: { number: { contains: s, mode: 'insensitive' } } },
      ];
    }

    const rows = await this.prisma.purchaseOrder.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: PURCHASE_ORDER_LIST_INCLUDE,
    });
    return rows.map((row) => this.toListItemDto(row));
  }

  async get(id: string): Promise<PurchaseOrderDetailDto> {
    const row = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: PURCHASE_ORDER_DETAIL_INCLUDE,
    });
    if (!row) throw new PurchaseOrderNotFoundException();
    return this.toDetailDto(row);
  }

  async listForCustomerOrder(
    customerOrderId: string,
  ): Promise<PurchaseOrderListItemDto[]> {
    return this.list({ customerOrderId });
  }

  // ===========================================================================
  // CREATE FROM NEEDS
  // ===========================================================================

  async createFromNeeds(
    dto: CreatePurchaseOrderFromNeedsDto,
    actorEmployeeId?: string | null,
  ): Promise<PurchaseOrderDetailDto> {
    if (!dto.workshopNeedIds || dto.workshopNeedIds.length === 0) {
      throw new PurchaseOrderNeedsRequiredException();
    }
    // Уникализируем — UI может прислать дубликаты при множественном
    // выделении (строка дважды попала в submit).
    const ids = Array.from(new Set(dto.workshopNeedIds));

    // 1. Загружаем потребности с supplier / catalog item / order /
    //    активными PO-линиями.
    const needs = await this.prisma.workshopNeed.findMany({
      where: { id: { in: ids } },
      include: {
        order: { select: { id: true, number: true } },
        // Фича «Варианты просчёта»: PO — реальные деньги, разрешён
        // только под АКТИВНЫЙ (выбранный) вариант заказа.
        orderCalculation: { select: { id: true, title: true, isActive: true } },
        selectedSupplier: true,
        selectedSupplierCatalogItem: true,
        purchaseOrderLines: {
          where: {
            status: { in: PURCHASE_ORDER_LINE_ACTIVE_STATUSES as string[] },
          },
          select: { id: true, status: true, purchaseOrderId: true },
        },
      },
    });
    if (needs.length !== ids.length) {
      // Хотя бы одной потребности нет в БД.
      throw new PurchaseOrderNeedsRequiredException();
    }

    // 2. Базовые проверки.
    for (const n of needs) {
      if (n.status === 'CANCELLED') {
        throw new PurchaseOrderNeedsRequiredException();
      }
      // Фича «Варианты просчёта»: строка неактивного варианта — это
      // сравнительный просчёт, закупать под него нельзя. Адресная 409
      // вместо тихой закупки не того материала.
      if (n.orderCalculation && !n.orderCalculation.isActive) {
        throw new ConflictException({
          statusCode: 409,
          code: 'PURCHASE_ORDER_NEED_INACTIVE_CALCULATION',
          message:
            `Строка «${n.description}» относится к варианту просчёта ` +
            `«${n.orderCalculation.title}», который сейчас не выбран. ` +
            'Заказы поставщику создаются только под активный вариант — ' +
            'переключите вариант в карточке заказа либо выберите строки активного варианта.',
        });
      }
      if (!n.selectedSupplierId) {
        throw new PurchaseOrderNeedsSupplierRequiredException();
      }
      if (!n.purchaseQty || n.purchaseQty.lessThanOrEqualTo(0)) {
        throw new PurchaseOrderNeedPurchaseQtyRequiredException();
      }
      if (n.purchaseOrderLines.length > 0) {
        throw new PurchaseOrderNeedAlreadyOrderedException();
      }
    }

    const supplierIds = new Set(needs.map((n) => n.selectedSupplierId!));
    if (supplierIds.size > 1) {
      throw new PurchaseOrderNeedsDifferentSuppliersException();
    }
    const supplierId = needs[0].selectedSupplierId!;
    const supplier = needs[0].selectedSupplier;
    if (!supplier) {
      // На уровне БД supplier гарантирован FK + проверка выше, но
      // TypeScript не знает; на всякий случай — те же 422.
      throw new PurchaseOrderNeedsSupplierRequiredException();
    }
    if (supplier.status !== 'ACTIVE') {
      throw new SupplierInactiveException();
    }

    const orderIds = new Set(needs.map((n) => n.orderId));
    if (orderIds.size > 1) {
      throw new PurchaseOrderNeedsDifferentOrdersException();
    }
    const customerOrderId = needs[0].orderId;
    const customerOrder = needs[0].order;

    // 3. Готовим snapshot строк и подбираем дату.
    const lines = needs.map((n) => {
      const item = n.selectedSupplierCatalogItem;
      const itemNameSnapshot =
        (item?.name && item.name.trim() !== '' ? item.name : null) ??
        n.purchaseItemNameText ??
        n.description;
      const supplierArticleSnapshot = item?.supplierArticle ?? null;
      // Единица ОБЯЗАНА описывать то число, которое рядом: `qty` — это
      // `WorkshopNeed.purchaseQty`, посчитанное в единице ПОТРЕБНОСТИ.
      // Раньше здесь предпочиталась единица позиции каталога, а
      // количество оставалось прежним, и совместимость нигде не
      // проверялась: потребность «600 м пог.» уходила поставщику как
      // «600 кг» — заказ примерно в шесть раз больше нужного.
      //
      // Расхождение не глушим 422: закупщик выбрал позицию каталога
      // осознанно и править справочник поставщика не обязан. Берём
      // единицу потребности и пишем расхождение в лог, чтобы его было
      // видно.
      const catalogUnit =
        item?.unit && item.unit.trim() !== '' ? item.unit.trim() : null;
      const unitSnapshot = n.unit;
      if (
        catalogUnit &&
        catalogUnit.toLowerCase() !== (n.unit ?? '').trim().toLowerCase()
      ) {
        this.logger.warn(
          `event=purchase_order.unit_mismatch needId=${n.id} ` +
            `needUnit=${n.unit} catalogUnit=${catalogUnit} ` +
            `catalogItemId=${n.selectedSupplierCatalogItemId ?? 'null'}`,
        );
      }
      const catalogLastPriceSnapshot = item?.lastPrice ?? null;
      const currency =
        (n.quotedCurrency && n.quotedCurrency.trim() !== ''
          ? n.quotedCurrency
          : null) ??
        (item?.currency && item.currency.trim() !== ''
          ? item.currency
          : null) ??
        'RUB';
      return {
        workshopNeedId: n.id,
        supplierCatalogItemId: n.selectedSupplierCatalogItemId,
        itemNameSnapshot,
        supplierArticleSnapshot,
        unitSnapshot,
        catalogLastPriceSnapshot,
        qty: n.purchaseQty!,
        price: n.quotedPrice ?? null,
        currency,
        expectedDeliveryDate: n.expectedDeliveryDate,
      };
    });

    const headerExpectedDate = dto.expectedDeliveryDate
      ? new Date(dto.expectedDeliveryDate)
      : (() => {
          const dates = lines
            .map((l) => l.expectedDeliveryDate)
            .filter((d): d is Date => d != null);
          if (dates.length === 0) return null;
          // Берём самую раннюю — закупщику важнее «когда минимум придёт».
          return new Date(Math.min(...dates.map((d) => d.getTime())));
        })();

    // 4. Транзакция: номер → PurchaseOrder → PurchaseOrderLine[] →
    //    обновление статуса WorkshopNeed → audit.
    const created = await this.prisma.$transaction(async (tx) => {
      const number = await this.numberService.nextNumber(tx);
      const po = await tx.purchaseOrder.create({
        data: {
          number,
          supplier: { connect: { id: supplierId } },
          supplierNameSnapshot: supplier.name,
          supplierPhoneSnapshot: supplier.phone ?? null,
          supplierWebsiteSnapshot: supplier.website ?? null,
          supplierAddressSnapshot: supplier.address ?? null,
          customerOrder: customerOrderId
            ? { connect: { id: customerOrderId } }
            : undefined,
          status: 'DRAFT',
          expectedDeliveryDate: headerExpectedDate,
          comment: dto.comment ?? null,
          createdBy: actorEmployeeId
            ? { connect: { id: actorEmployeeId } }
            : undefined,
          lines: {
            create: lines.map((l) => ({
              workshopNeedId: l.workshopNeedId,
              supplierCatalogItemId: l.supplierCatalogItemId,
              itemNameSnapshot: l.itemNameSnapshot,
              supplierArticleSnapshot: l.supplierArticleSnapshot,
              unitSnapshot: l.unitSnapshot,
              catalogLastPriceSnapshot: l.catalogLastPriceSnapshot,
              qty: l.qty,
              price: l.price,
              currency: l.currency,
              expectedDeliveryDate: l.expectedDeliveryDate,
              status: 'DRAFT',
            })),
          },
        },
      });

      await tx.workshopNeed.updateMany({
        where: { id: { in: needs.map((n) => n.id) } },
        data: { status: 'ORDERED' },
      });

      await this.audit.log(
        {
          event: 'PURCHASE_ORDER_CREATED',
          entityType: 'PURCHASE_ORDER',
          entityId: po.id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            purchaseOrderId: po.id,
            number: po.number,
            supplierId,
            customerOrderId,
            customerOrderNumber: customerOrder?.number ?? null,
            workshopNeedIds: needs.map((n) => n.id),
            linesCount: lines.length,
          },
        },
        tx,
      );

      return po;
    });

    this.logger.log(
      `event=purchase_order.create id=${created.id} number=${created.id} supplierId=${supplierId} ` +
        `linesCount=${lines.length} customerOrderId=${customerOrderId ?? '-'}`,
    );

    return this.get(created.id);
  }

  // ===========================================================================
  // UPDATE PO header / line
  // ===========================================================================

  async update(
    id: string,
    dto: UpdatePurchaseOrderDto,
    actorEmployeeId?: string | null,
  ): Promise<PurchaseOrderDetailDto> {
    const current = await this.prisma.purchaseOrder.findUnique({
      where: { id },
    });
    if (!current) throw new PurchaseOrderNotFoundException();

    const data: Prisma.PurchaseOrderUpdateInput = {};
    const changedFields: string[] = [];

    if (dto.comment !== undefined) {
      data.comment = dto.comment;
      changedFields.push('comment');
    }
    if (dto.expectedDeliveryDate !== undefined) {
      data.expectedDeliveryDate =
        dto.expectedDeliveryDate === null
          ? null
          : new Date(dto.expectedDeliveryDate);
      changedFields.push('expectedDeliveryDate');
    }
    if (dto.status !== undefined && dto.status !== current.status) {
      this.assertStatusTransition(current.status, dto.status);
      data.status = dto.status;
      changedFields.push('status');
      // Прямой PATCH статуса timestamps не выставляет — для этого
      // есть выделенные actions /send /confirm /cancel. Это сознательно:
      // сюда мы попадаем только при ручной коррекции, и не хотим
      // случайно перезаписать `confirmedAt` / `cancelledAt`.
    }

    if (Object.keys(data).length === 0) return this.get(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.update({ where: { id }, data });
      await this.audit.log(
        {
          event: 'PURCHASE_ORDER_UPDATED',
          entityType: 'PURCHASE_ORDER',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            changedFields,
            after: {
              comment: dto.comment,
              expectedDeliveryDate: dto.expectedDeliveryDate,
              status: dto.status,
            },
          },
        },
        tx,
      );
    });

    return this.get(id);
  }

  async updateLine(
    id: string,
    lineId: string,
    dto: UpdatePurchaseOrderLineDto,
    actorEmployeeId?: string | null,
  ): Promise<PurchaseOrderDetailDto> {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!order) throw new PurchaseOrderNotFoundException();

    const line = await this.prisma.purchaseOrderLine.findUnique({
      where: { id: lineId },
    });
    if (!line || line.purchaseOrderId !== id) {
      throw new PurchaseOrderLineNotFoundException();
    }

    const data: Prisma.PurchaseOrderLineUpdateInput = {};
    const changedFields: string[] = [];

    if (dto.qty !== undefined) {
      data.qty = dto.qty === null ? undefined : new Prisma.Decimal(dto.qty);
      // qty NOT NULL: пустое значение по факту значит «не трогать».
      if (dto.qty !== null) changedFields.push('qty');
    }
    if (dto.price !== undefined) {
      data.price = dto.price === null ? null : new Prisma.Decimal(dto.price);
      changedFields.push('price');
    }
    if (dto.currency !== undefined) {
      data.currency = dto.currency;
      changedFields.push('currency');
    }
    if (dto.expectedDeliveryDate !== undefined) {
      data.expectedDeliveryDate =
        dto.expectedDeliveryDate === null
          ? null
          : new Date(dto.expectedDeliveryDate);
      changedFields.push('expectedDeliveryDate');
    }
    if (dto.confirmedQty !== undefined) {
      data.confirmedQty =
        dto.confirmedQty === null
          ? null
          : new Prisma.Decimal(dto.confirmedQty);
      changedFields.push('confirmedQty');
    }
    if (dto.confirmedPrice !== undefined) {
      data.confirmedPrice =
        dto.confirmedPrice === null
          ? null
          : new Prisma.Decimal(dto.confirmedPrice);
      changedFields.push('confirmedPrice');
    }
    if (dto.confirmedDeliveryDate !== undefined) {
      data.confirmedDeliveryDate =
        dto.confirmedDeliveryDate === null
          ? null
          : new Date(dto.confirmedDeliveryDate);
      changedFields.push('confirmedDeliveryDate');
    }
    if (dto.comment !== undefined) {
      data.comment = dto.comment;
      changedFields.push('comment');
    }
    if (dto.status !== undefined && dto.status !== line.status) {
      data.status = dto.status;
      changedFields.push('status');
    }

    if (Object.keys(data).length === 0) return this.get(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseOrderLine.update({ where: { id: lineId }, data });
      await this.audit.log(
        {
          event: 'PURCHASE_ORDER_LINE_UPDATED',
          entityType: 'PURCHASE_ORDER',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            lineId,
            changedFields,
            after: dto,
          },
        },
        tx,
      );
    });

    return this.get(id);
  }

  // ===========================================================================
  // ACTIONS: send / confirm / cancel
  // ===========================================================================

  async send(
    id: string,
    actorEmployeeId?: string | null,
  ): Promise<PurchaseOrderDetailDto> {
    const current = await this.prisma.purchaseOrder.findUnique({
      where: { id },
    });
    if (!current) throw new PurchaseOrderNotFoundException();
    this.assertStatusTransition(current.status, 'SENT');

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'SENT', sentAt: now },
      });
      await tx.purchaseOrderLine.updateMany({
        where: { purchaseOrderId: id, status: 'DRAFT' },
        data: { status: 'SENT' },
      });
      await this.audit.log(
        {
          event: 'PURCHASE_ORDER_SENT',
          entityType: 'PURCHASE_ORDER',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: { previousStatus: current.status, sentAt: now.toISOString() },
        },
        tx,
      );
    });

    return this.get(id);
  }

  async confirm(
    id: string,
    dto: ConfirmPurchaseOrderDto,
    actorEmployeeId?: string | null,
  ): Promise<PurchaseOrderDetailDto> {
    const current = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: { lines: { select: { id: true, status: true } } },
    });
    if (!current) throw new PurchaseOrderNotFoundException();
    this.assertStatusTransition(current.status, 'CONFIRMED');

    const confirmedAt = dto.confirmedAt
      ? new Date(dto.confirmedAt)
      : new Date();

    const lineUpdatesInput = dto.lines ?? [];
    // Валидируем lineId — все должны принадлежать этому PO.
    if (lineUpdatesInput.length > 0) {
      const ownIds = new Set(current.lines.map((l) => l.id));
      for (const lu of lineUpdatesInput) {
        if (!ownIds.has(lu.lineId)) {
          throw new PurchaseOrderLineNotFoundException();
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'CONFIRMED', confirmedAt },
      });

      // Сначала точечно обновляем строки с подтверждениями (qty/
      // price/date/comment), потом массово ставим всем активным
      // строкам status = CONFIRMED.
      for (const lu of lineUpdatesInput) {
        const data: Prisma.PurchaseOrderLineUpdateInput = {};
        if (lu.confirmedQty !== undefined) {
          data.confirmedQty =
            lu.confirmedQty === null
              ? null
              : new Prisma.Decimal(lu.confirmedQty);
        }
        if (lu.confirmedPrice !== undefined) {
          data.confirmedPrice =
            lu.confirmedPrice === null
              ? null
              : new Prisma.Decimal(lu.confirmedPrice);
        }
        if (lu.confirmedDeliveryDate !== undefined) {
          data.confirmedDeliveryDate =
            lu.confirmedDeliveryDate === null
              ? null
              : new Date(lu.confirmedDeliveryDate);
        }
        if (lu.comment !== undefined) data.comment = lu.comment;
        if (Object.keys(data).length > 0) {
          await tx.purchaseOrderLine.update({
            where: { id: lu.lineId },
            data,
          });
        }
      }

      await tx.purchaseOrderLine.updateMany({
        where: {
          purchaseOrderId: id,
          status: { in: ['DRAFT', 'SENT'] },
        },
        data: { status: 'CONFIRMED' },
      });

      await this.audit.log(
        {
          event: 'PURCHASE_ORDER_CONFIRMED',
          entityType: 'PURCHASE_ORDER',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            previousStatus: current.status,
            confirmedAt: confirmedAt.toISOString(),
            lineConfirmations: lineUpdatesInput.length,
          },
        },
        tx,
      );
    });

    return this.get(id);
  }

  async cancel(
    id: string,
    actorEmployeeId?: string | null,
  ): Promise<PurchaseOrderDetailDto> {
    const current = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        lines: { select: { id: true, workshopNeedId: true, status: true } },
      },
    });
    if (!current) throw new PurchaseOrderNotFoundException();
    if (current.status === 'CANCELLED') {
      // Идемпотентность: повторная отмена не считается ошибкой.
      return this.get(id);
    }
    this.assertStatusTransition(current.status, 'CANCELLED');

    const now = new Date();
    const needIdsToCheck = Array.from(
      new Set(
        current.lines
          .map((l) => l.workshopNeedId)
          .filter((v): v is string => !!v),
      ),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: now },
      });
      await tx.purchaseOrderLine.updateMany({
        where: {
          purchaseOrderId: id,
          status: { not: 'CANCELLED' },
        },
        data: { status: 'CANCELLED' },
      });

      // Возвращаем WorkshopNeed → PURCHASE_PLANNED, если по нему
      // больше нет активных строк PO. На MVP это самый «чистый»
      // вариант возврата: не считаем `REVIEWED`/`CALCULATED`,
      // потому что после ручного выбора поставщика и `purchaseQty`
      // потребность по факту уже была в PURCHASE_PLANNED-state.
      const restoredNeedIds: string[] = [];
      for (const needId of needIdsToCheck) {
        const stillActive = await tx.purchaseOrderLine.count({
          where: {
            workshopNeedId: needId,
            status: { in: PURCHASE_ORDER_LINE_ACTIVE_STATUSES as string[] },
          },
        });
        if (stillActive === 0) {
          const need = await tx.workshopNeed.findUnique({
            where: { id: needId },
            select: { id: true, status: true },
          });
          // Возвращаем только если потребность сейчас в `ORDERED` —
          // т.е. её перевела сюда именно эта (или такая же) PO.
          // Если закупщик за это время руками сменил статус
          // (например, на `CANCELLED`), не трогаем.
          if (need && need.status === 'ORDERED') {
            await tx.workshopNeed.update({
              where: { id: needId },
              data: { status: 'PURCHASE_PLANNED' },
            });
            restoredNeedIds.push(needId);
          }
        }
      }

      await this.audit.log(
        {
          event: 'PURCHASE_ORDER_CANCELLED',
          entityType: 'PURCHASE_ORDER',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            previousStatus: current.status,
            cancelledAt: now.toISOString(),
            restoredNeedIds,
          },
        },
        tx,
      );
    });

    return this.get(id);
  }

  /**
   * Откат статуса PO на шаг назад («переоткрыть»):
   *   CONFIRMED → SENT   (снять подтверждение);
   *   SENT      → DRAFT   (вернуть в черновик).
   *
   * Разрешён только если по заказу НЕТ проведённых приёмок
   * (статус не `PARTIALLY_RECEIVED`/`RECEIVED` и нет POSTED-
   * `PurchaseReceipt`). Иначе — `PurchaseOrderHasReceiptsException`.
   * Это закрывает «тупик» прежней линейной машины статусов: раньше
   * ошибочно отправленный/подтверждённый заказ можно было только
   * отменить.
   */
  async reopen(
    id: string,
    actorEmployeeId?: string | null,
  ): Promise<PurchaseOrderDetailDto> {
    const current = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!current) throw new PurchaseOrderNotFoundException();

    if (current.status !== 'CONFIRMED' && current.status !== 'SENT') {
      throw new PurchaseOrderInvalidStatusTransitionException(
        `Откатить статус можно только из SENT или CONFIRMED. Текущий статус: ${current.status}.`,
      );
    }

    // Защита: нет ни одной активной (не CANCELLED) приёмки по заказу.
    const activeReceipts = await this.prisma.purchaseReceipt.count({
      where: { purchaseOrderId: id, status: { not: 'CANCELLED' } },
    });
    if (activeReceipts > 0) {
      throw new PurchaseOrderHasReceiptsException();
    }

    const target: 'SENT' | 'DRAFT' =
      current.status === 'CONFIRMED' ? 'SENT' : 'DRAFT';

    await this.prisma.$transaction(async (tx) => {
      if (target === 'SENT') {
        // CONFIRMED → SENT: снимаем confirmedAt, строки CONFIRMED → SENT.
        await tx.purchaseOrder.update({
          where: { id },
          data: { status: 'SENT', confirmedAt: null },
        });
        await tx.purchaseOrderLine.updateMany({
          where: { purchaseOrderId: id, status: 'CONFIRMED' },
          data: { status: 'SENT' },
        });
      } else {
        // SENT → DRAFT: снимаем sentAt, строки SENT → DRAFT.
        await tx.purchaseOrder.update({
          where: { id },
          data: { status: 'DRAFT', sentAt: null },
        });
        await tx.purchaseOrderLine.updateMany({
          where: { purchaseOrderId: id, status: 'SENT' },
          data: { status: 'DRAFT' },
        });
      }

      await this.audit.log(
        {
          event: 'PURCHASE_ORDER_REOPENED',
          entityType: 'PURCHASE_ORDER',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: { previousStatus: current.status, newStatus: target },
        },
        tx,
      );
    });

    return this.get(id);
  }

  // ===========================================================================
  // INTERNAL: status transitions
  // ===========================================================================

  /**
   * Допустимые переходы статуса PO. На MVP линейные:
   *   DRAFT → SENT → CONFIRMED
   *   {DRAFT|SENT|CONFIRMED} → CANCELLED
   * Все откаты (SENT → DRAFT, CONFIRMED → SENT, …) запрещены.
   */
  private assertStatusTransition(from: string, to: string): void {
    if (from === to) return;
    if (from === 'CANCELLED') {
      throw new PurchaseOrderInvalidStatusTransitionException(
        'Из CANCELLED обратно перевести нельзя',
      );
    }
    if (to === 'CANCELLED') return; // любой → CANCELLED разрешён
    if (from === 'DRAFT' && (to === 'SENT' || to === 'CONFIRMED')) return;
    if (from === 'SENT' && to === 'CONFIRMED') return;
    throw new PurchaseOrderInvalidStatusTransitionException(
      `Недопустимый переход статуса PO: ${from} → ${to}`,
    );
  }

  // ===========================================================================
  // MAPPERS
  // ===========================================================================

  private toListItemDto(
    row: Prisma.PurchaseOrderGetPayload<{
      include: typeof PURCHASE_ORDER_LIST_INCLUDE;
    }>,
  ): PurchaseOrderListItemDto {
    return {
      id: row.id,
      number: row.number,
      supplierId: row.supplierId,
      supplierNameSnapshot: row.supplierNameSnapshot,
      customerOrderId: row.customerOrderId,
      customerOrderNumber: row.customerOrder?.number ?? null,
      status: row.status,
      expectedDeliveryDate: row.expectedDeliveryDate
        ? row.expectedDeliveryDate.toISOString()
        : null,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      linesCount: row._count.lines,
      totalAmount: this.computeTotalAmount(row.lines),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toDetailDto(
    row: Prisma.PurchaseOrderGetPayload<{
      include: typeof PURCHASE_ORDER_DETAIL_INCLUDE;
    }>,
  ): PurchaseOrderDetailDto {
    return {
      id: row.id,
      number: row.number,
      supplierId: row.supplierId,
      supplierNameSnapshot: row.supplierNameSnapshot,
      customerOrderId: row.customerOrderId,
      customerOrderNumber: row.customerOrder?.number ?? null,
      status: row.status,
      expectedDeliveryDate: row.expectedDeliveryDate
        ? row.expectedDeliveryDate.toISOString()
        : null,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      linesCount: row.lines.length,
      totalAmount: this.computeTotalAmount(row.lines),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      supplierPhoneSnapshot: row.supplierPhoneSnapshot,
      supplierWebsiteSnapshot: row.supplierWebsiteSnapshot,
      supplierAddressSnapshot: row.supplierAddressSnapshot,
      comment: row.comment,
      lines: row.lines.map((l) => this.lineToDto(l)),
    };
  }

  private lineToDto(
    l: Prisma.PurchaseOrderLineGetPayload<{
      include: {
        workshopNeed: {
          select: {
            description: true;
            order: { select: { number: true } };
          };
        };
      };
    }>,
  ): PurchaseOrderLineDto {
    return {
      id: l.id,
      workshopNeedId: l.workshopNeedId,
      supplierCatalogItemId: l.supplierCatalogItemId,
      itemNameSnapshot: l.itemNameSnapshot,
      supplierArticleSnapshot: l.supplierArticleSnapshot,
      unitSnapshot: l.unitSnapshot,
      catalogLastPriceSnapshot: l.catalogLastPriceSnapshot
        ? l.catalogLastPriceSnapshot.toString()
        : null,
      qty: l.qty.toString(),
      price: l.price ? l.price.toString() : null,
      currency: l.currency,
      expectedDeliveryDate: l.expectedDeliveryDate
        ? l.expectedDeliveryDate.toISOString()
        : null,
      confirmedQty: l.confirmedQty ? l.confirmedQty.toString() : null,
      confirmedPrice: l.confirmedPrice ? l.confirmedPrice.toString() : null,
      confirmedDeliveryDate: l.confirmedDeliveryDate
        ? l.confirmedDeliveryDate.toISOString()
        : null,
      status: l.status,
      comment: l.comment,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
      workshopNeedDescription: l.workshopNeed?.description ?? null,
      customerOrderNumber: l.workshopNeed?.order?.number ?? null,
    };
  }

  /**
   * Σ(qty × price) по активным (не CANCELLED) строкам. Возвращаем
   * как строку для совместимости с DTO-форматом «Decimal как строка».
   * Если ни в одной активной строке нет `price`, возвращаем `null`
   * (нет смысла показывать «0₽» — путает менеджера).
   */
  private computeTotalAmount(
    lines: { qty: Prisma.Decimal; price: Prisma.Decimal | null; status: string }[],
  ): string | null {
    let total = new Prisma.Decimal(0);
    let hasPrice = false;
    for (const l of lines) {
      if (l.status === 'CANCELLED') continue;
      if (l.price == null) continue;
      hasPrice = true;
      total = total.add(l.qty.mul(l.price));
    }
    if (!hasPrice) return null;
    return total.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toString();
  }
}

// ---------------------------------------------------------------------------
// Includes (источник истины для list/get)
// ---------------------------------------------------------------------------

const PURCHASE_ORDER_LIST_INCLUDE = {
  customerOrder: { select: { id: true, number: true } },
  lines: { select: { id: true, qty: true, price: true, status: true } },
  _count: { select: { lines: true } },
} as const satisfies Prisma.PurchaseOrderInclude;

const PURCHASE_ORDER_DETAIL_INCLUDE = {
  customerOrder: { select: { id: true, number: true } },
  lines: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      workshopNeed: {
        select: {
          description: true,
          order: { select: { number: true } },
        },
      },
    },
  },
} as const satisfies Prisma.PurchaseOrderInclude;
