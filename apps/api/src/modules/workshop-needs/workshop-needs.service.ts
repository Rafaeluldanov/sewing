import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type OrderStatus, type WorkshopNeed } from '@prisma/client';
import type {
  CalculateWorkshopNeedsDto,
  CalculateWorkshopNeedsResultDto,
  CreateManualWorkshopNeedDto,
  ListWorkshopNeedsQuery,
  UpdateWorkshopNeedDto,
  WorkshopNeedArchiveSkipDto,
  WorkshopNeedDto,
  WorkshopNeedListItemDto,
  WorkshopNeedOrderCalculationFilter,
  WorkshopNeedsArchiveResultDto,
} from '@sewing/shared/workshop-needs';
import {
  ORDER_APPLICATION_STAGE_LABELS,
  ORDER_APPLICATION_TYPE_LABELS,
  type OrderApplicationStage,
  type OrderApplicationType,
} from '@sewing/shared/order-applications';
import {
  getMaterialCharacteristic,
  type MaterialCharacteristics,
} from '@sewing/shared/material-characteristics';
import {
  computeNormPurchase,
  needsPurchaseConversion,
} from '@sewing/shared/norm-purchase';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  SupplierCatalogItemInactiveException,
  SupplierCatalogItemNotFoundException,
  SupplierCatalogItemSupplierMismatchException,
  SupplierInactiveException,
  SupplierNotFoundException,
  WorkshopNeedCalculationOverflowException,
  WorkshopNeedCalculationSourceException,
  WorkshopNeedNotFoundException,
  WorkshopNeedNotManualException,
  WorkshopNeedOrderItemsRequiredException,
  WorkshopNeedsAlreadyReviewedException,
  WorkshopNeedsHaveStockException,
} from '../../common/errors.js';
import { assertOrderMaterialCorrectionAllowed } from '../../common/order-material-correction.js';
import { ACTIVE_CALCULATION_NEED_WHERE } from './workshop-need-scope.js';

/**
 * Реализация модуля «Потребность цеха» (Этап 4А, см.
 * `docs/recon-soft-integration.md §«Этап 4А»`).
 *
 * Бизнес-логика:
 *   - расчёт чистой потребности заказа, без потерь и закупочных
 *     номенклатур;
 *   - источник материалов: live `TechCardMaterialLine` для DRAFT-
 *     заказа, snapshot `OrderMaterialRequirement` для запущенного
 *     (или DRAFT-заказа, у которого snapshot уже есть);
 *   - формула AREA_DENSITY:
 *       totalAreaM2 = Σ (PatternMaterialArea.areaM2 × OrderItem.qtyPlan)
 *       calculatedQty = totalAreaM2 × densityGsm / 1000
 *   - fallback QTY_PER_UNIT:
 *       calculatedQty = qtyPerUnit × Σ qtyPlan (live)
 *                     | requirement.totalQty (snapshot);
 *   - закупщик правит `purchaseQty` / `status` и
 *     `supplierNameText`/`purchaseItemNameText` руками;
 *   - идемпотентный пересчёт: сносим только `CALCULATED`-строки,
 *     `REVIEWED`/`PURCHASE_PLANNED` сохраняем (если не передан
 *     `force`).
 *
 * Этот модуль НЕ создаёт заказы поставщикам, НЕ ведёт справочник
 * поставщиков и НЕ считает потери — это сознательная граница MVP
 * (см. ТЗ Этапа 4А).
 */
@Injectable()
export class WorkshopNeedsService {
  private readonly logger = new Logger(WorkshopNeedsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // LIST / GET
  // -------------------------------------------------------------------------

  async list(
    query: ListWorkshopNeedsQuery,
  ): Promise<WorkshopNeedListItemDto[]> {
    const where: Prisma.WorkshopNeedWhereInput = {};
    if (query.orderId) where.orderId = query.orderId;
    if (query.status) where.status = query.status;

    // Фича «Варианты просчёта»: потребности сосуществуют для нескольких
    // вариантов заказа. `calculationScope=ACTIVE` — только строки
    // активного варианта (+ вне контура вариантов: sample/legacy) —
    // так ходят производственно-финансовые читатели карточки заказа.
    // Default (ALL) — закупочные экраны видят все варианты с меткой.
    // Подмешиваем через AND: у фрагмента свой OR (см. workshop-need-scope).
    if (query.calculationScope === 'ACTIVE') {
      where.AND = [ACTIVE_CALCULATION_NEED_WHERE];
    }

    // -----------------------------------------------------------------------
    // Управленческий фильтр «Статус расчёта» (см. ТЗ
    // `/admin/workshop-needs?orderCalculationStatus=...`).
    //
    // Default зависит от того, ходим ли мы за конкретным заказом:
    //   - без `orderId` — общий список, показываем только
    //     `Order.status = CALCULATION` (то, что закупщик сейчас ведёт).
    //     Завершённые расчёты прячутся, чтобы не мешать в работе;
    //   - c `orderId` — карточка заказа, default = `ALL`. Иначе сразу
    //     после `completeCalculation` карточка теряла бы свои
    //     потребности.
    //
    // Фильтр по `WorkshopNeed.status` (поле `query.status` выше)
    // оставлен как технический и работает поверх — например,
    // `?orderCalculationStatus=ALL&status=CALCULATED` отдаст все
    // CALCULATED-строки независимо от статуса заказа.
    // -----------------------------------------------------------------------
    const effectiveOrderCalculationStatus =
      query.orderCalculationStatus ?? (query.orderId ? 'ALL' : 'ACTIVE');
    if (effectiveOrderCalculationStatus !== 'ALL') {
      where.order = mergeOrderWhere(where.order, {
        status:
          ORDER_CALCULATION_FILTER_ORDER_STATUS[
            effectiveOrderCalculationStatus
          ],
      });
    }

    // Фича «Архив расчётов цеха»: скоуп по `Order.needsArchivedAt`.
    // Default симметричен `orderCalculationStatus` — зависит от наличия
    // `orderId`: общий список закупщика скрывает архив (`ACTIVE`),
    // карточка конкретного заказа видит свои потребности даже если заказ
    // архивирован (`ALL`). Явный `orderArchive` перекрывает default.
    const effectiveArchive =
      query.orderArchive ?? (query.orderId ? 'ALL' : 'ACTIVE');
    if (effectiveArchive === 'ACTIVE') {
      where.order = mergeOrderWhere(where.order, { needsArchivedAt: null });
    } else if (effectiveArchive === 'ARCHIVED') {
      where.order = mergeOrderWhere(where.order, {
        needsArchivedAt: { not: null },
      });
    }

    if (query.search && query.search.length > 0) {
      const s = query.search;
      where.OR = [
        { description: { contains: s, mode: 'insensitive' } },
        { sourceName: { contains: s, mode: 'insensitive' } },
        { supplierNameText: { contains: s, mode: 'insensitive' } },
        { purchaseItemNameText: { contains: s, mode: 'insensitive' } },
        { order: { number: { contains: s, mode: 'insensitive' } } },
        // Этап 5: поиск по имени связанного поставщика и его номенклатуре,
        // чтобы закупщик мог быстро найти строки конкретного контрагента.
        { selectedSupplier: { name: { contains: s, mode: 'insensitive' } } },
        {
          selectedSupplierCatalogItem: {
            name: { contains: s, mode: 'insensitive' },
          },
        },
      ];
    }

    const rows = await this.prisma.workshopNeed.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: WORKSHOP_NEED_INCLUDE,
    });
    return rows.map((r) => this.toDto(r));
  }

  async getOne(id: string): Promise<WorkshopNeedDto> {
    const row = await this.prisma.workshopNeed.findUnique({
      where: { id },
      include: WORKSHOP_NEED_INCLUDE,
    });
    if (!row) throw new WorkshopNeedNotFoundException();
    return this.toDto(row);
  }

  // -------------------------------------------------------------------------
  // UPDATE / CANCEL
  // -------------------------------------------------------------------------

  async update(
    id: string,
    dto: UpdateWorkshopNeedDto,
    actorEmployeeId?: string | null,
  ): Promise<WorkshopNeedDto> {
    const existing = await this.prisma.workshopNeed.findUnique({
      where: { id },
    });
    if (!existing) throw new WorkshopNeedNotFoundException();

    // Этап «Корректировка материалов после просчёта»: состав строки
    // (description / unit / materialRole / calculatedQty) можно менять
    // ТОЛЬКО у ручных строк. Для системных snapshot-строк из техкарты
    // эти поля неизменяемы — закупщик правит лишь purchaseQty / цену /
    // поставщика / статус.
    const wantsCompositionChange =
      dto.description !== undefined ||
      dto.unit !== undefined ||
      dto.materialRole !== undefined ||
      dto.calculatedQty !== undefined;
    if (wantsCompositionChange && !existing.isManual) {
      throw new WorkshopNeedNotManualException();
    }

    const data: Prisma.WorkshopNeedUpdateInput = {};
    const changedFields: string[] = [];

    if (dto.description !== undefined) {
      data.description = dto.description;
      changedFields.push('description');
    }
    if (dto.unit !== undefined) {
      data.unit = dto.unit;
      changedFields.push('unit');
    }
    if (dto.materialRole !== undefined) {
      data.materialRole = dto.materialRole;
      changedFields.push('materialRole');
    }
    if (dto.calculatedQty !== undefined) {
      data.calculatedQty = new Prisma.Decimal(dto.calculatedQty);
      changedFields.push('calculatedQty');
    }

    function trackOptional<K extends keyof UpdateWorkshopNeedDto>(
      key: K,
      transform?: (v: NonNullable<UpdateWorkshopNeedDto[K]>) => unknown,
    ): { changed: boolean; value: unknown } {
      const raw = dto[key];
      if (raw === undefined) return { changed: false, value: undefined };
      const value = raw === null ? null : transform ? transform(raw as NonNullable<UpdateWorkshopNeedDto[K]>) : raw;
      return { changed: true, value };
    }

    const purchaseQty = trackOptional('purchaseQty', (v) =>
      v === null ? null : new Prisma.Decimal(v as string),
    );
    if (purchaseQty.changed) {
      data.purchaseQty = purchaseQty.value as Prisma.Decimal | null;
      changedFields.push('purchaseQty');
    }

    const packSize = trackOptional('packSize', (v) =>
      v === null ? null : new Prisma.Decimal(v as string),
    );
    if (packSize.changed) {
      data.packSize = packSize.value as Prisma.Decimal | null;
      changedFields.push('packSize');
    }

    if (dto.status !== undefined) {
      data.status = dto.status;
      changedFields.push('status');
    }
    if (dto.supplierNameText !== undefined) {
      data.supplierNameText = dto.supplierNameText;
      changedFields.push('supplierNameText');
    }
    if (dto.purchaseItemNameText !== undefined) {
      data.purchaseItemNameText = dto.purchaseItemNameText;
      changedFields.push('purchaseItemNameText');
    }
    if (dto.quotedPrice !== undefined) {
      data.quotedPrice =
        dto.quotedPrice === null ? null : new Prisma.Decimal(dto.quotedPrice);
      changedFields.push('quotedPrice');
    }
    if (dto.quotedCurrency !== undefined) {
      data.quotedCurrency = dto.quotedCurrency;
      changedFields.push('quotedCurrency');
    }
    if (dto.expectedDeliveryDate !== undefined) {
      data.expectedDeliveryDate =
        dto.expectedDeliveryDate === null
          ? null
          : new Date(dto.expectedDeliveryDate);
      changedFields.push('expectedDeliveryDate');
    }
    if (dto.comment !== undefined) {
      data.comment = dto.comment;
      changedFields.push('comment');
    }

    // -----------------------------------------------------------------------
    // Этап 5 «Поставщики»: разрешаем связь Supplier ↔ SupplierCatalogItem.
    //
    // Правила (см. ТЗ §6):
    //   - selectedSupplierId = null   → очистить supplier И catalog item;
    //   - selectedSupplierId = string → проверить exists + ACTIVE;
    //   - selectedSupplierCatalogItemId = null   → очистить только catalog item;
    //   - selectedSupplierCatalogItemId = string → проверить exists + ACTIVE,
    //       supplier должен совпадать (если указан); если supplier не
    //       указан — auto-set из catalog item.
    //   - текстовые supplierNameText / purchaseItemNameText НЕ
    //     перезаписываем (см. ТЗ §6 «Текстовые поля»).
    // -----------------------------------------------------------------------
    const supplierResolution = await this.resolveSupplierFields(
      existing,
      dto.selectedSupplierId,
      dto.selectedSupplierCatalogItemId,
    );
    if (supplierResolution.supplierTouched) {
      data.selectedSupplier =
        supplierResolution.supplierId == null
          ? { disconnect: true }
          : { connect: { id: supplierResolution.supplierId } };
      changedFields.push('selectedSupplierId');
    }
    if (supplierResolution.catalogItemTouched) {
      data.selectedSupplierCatalogItem =
        supplierResolution.catalogItemId == null
          ? { disconnect: true }
          : { connect: { id: supplierResolution.catalogItemId } };
      changedFields.push('selectedSupplierCatalogItemId');
    }

    if (Object.keys(data).length === 0) {
      // Zod refine уже отбивает «нечего обновлять», но на всякий случай.
      return this.getOne(id);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.workshopNeed.update({ where: { id }, data });
      await this.audit.log(
        {
          event: 'WORKSHOP_NEED_UPDATED',
          entityType: 'WORKSHOP_NEED',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId: existing.orderId,
            changedFields,
            // Запрос как пришёл (после Zod-нормализации). Decimal-поля
            // сериализуем строкой, как и в DTO — чтобы payload был
            // самодостаточен и не требовал отдельного типа.
            after: {
              description: dto.description,
              unit: dto.unit,
              materialRole: dto.materialRole,
              calculatedQty: dto.calculatedQty,
              purchaseQty:
                dto.purchaseQty === undefined
                  ? undefined
                  : (dto.purchaseQty as string | null),
              packSize:
                dto.packSize === undefined
                  ? undefined
                  : (dto.packSize as string | null),
              status: dto.status,
              supplierNameText: dto.supplierNameText,
              purchaseItemNameText: dto.purchaseItemNameText,
              quotedPrice:
                dto.quotedPrice === undefined
                  ? undefined
                  : (dto.quotedPrice as string | null),
              quotedCurrency: dto.quotedCurrency,
              expectedDeliveryDate: dto.expectedDeliveryDate,
              comment: dto.comment,
              selectedSupplierId: supplierResolution.supplierTouched
                ? supplierResolution.supplierId
                : undefined,
              selectedSupplierCatalogItemId:
                supplierResolution.catalogItemTouched
                  ? supplierResolution.catalogItemId
                  : undefined,
            },
          },
        },
        tx,
      );
    });

    this.logger.log(
      `event=workshop_need.update id=${id} fields=${changedFields.join(',')}`,
    );
    return this.getOne(id);
  }

  async cancel(
    id: string,
    actorEmployeeId?: string | null,
  ): Promise<WorkshopNeedDto> {
    const existing = await this.prisma.workshopNeed.findUnique({
      where: { id },
    });
    if (!existing) throw new WorkshopNeedNotFoundException();

    if (existing.status === 'CANCELLED') {
      // Идемпотентность: повторная отмена не считается ошибкой.
      return this.getOne(id);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.workshopNeed.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });
      await this.audit.log(
        {
          event: 'WORKSHOP_NEED_CANCELLED',
          entityType: 'WORKSHOP_NEED',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId: existing.orderId,
            previousStatus: existing.status,
          },
        },
        tx,
      );
    });
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // BULK ACCEPT (экран «Согласование закупки»)
  // -------------------------------------------------------------------------

  /**
   * «Принять теорию для непроверенных» — bulk-операция экрана
   * «Согласование закупки» (`/admin/orders/[id]/purchase-validation`).
   *
   * Менеджер обзвонил поставщиков, вручную поправил строки, где объём/
   * цена изменились, а по остальным решил «оставить как есть». Эта
   * операция закрывает хвост одним действием: каждая строка заказа в
   * статусе `CALCULATED` получает
   *   - `purchaseQty := purchaseQty ?? calculatedQty` — теория копируется
   *     в факт ЯВНО (решение владельца: в смете и план→факт документе
   *     должно быть видно согласованное число, а не «прочерк + fallback»);
   *     уже введённый закупщиком `purchaseQty` НЕ перетирается;
   *   - `status = REVIEWED` — строка засчитана как проверенная.
   *
   * Не трогаем: `CANCELLED` (погашена), `REVIEWED`/`PURCHASE_PLANNED`+
   * (уже проверены/дальше по конвейеру), ручные строки (создаются сразу
   * `REVIEWED`). Статус заказа сознательно НЕ гейтим — паритет с
   * построчным `update()`, который тоже доступен в любом статусе заказа.
   *
   * На себестоимость влияет так же, как построчная правка: смета
   * пересобирается только явным `completeCalculation` /
   * `recalculateCostEstimate` (см. `OrderCostEstimatesService`).
   */
  async acceptCalculatedForOrder(
    orderId: string,
    actorEmployeeId?: string | null,
  ): Promise<{ orderId: string; updated: number }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'Заказ не найден',
        code: 'ORDER_NOT_FOUND',
      });
    }

    // Фича «Варианты просчёта»: bulk-«принять теорию» работает только по
    // строкам АКТИВНОГО варианта — иначе один клик пометил бы REVIEWED
    // потребности всех вариантов сравнения.
    const pending = await this.prisma.workshopNeed.findMany({
      where: {
        orderId,
        status: 'CALCULATED',
        AND: [ACTIVE_CALCULATION_NEED_WHERE],
      },
      select: { id: true, purchaseQty: true, calculatedQty: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (pending.length === 0) {
      return { orderId, updated: 0 };
    }

    await this.prisma.$transaction(async (tx) => {
      for (const need of pending) {
        await tx.workshopNeed.update({
          where: { id: need.id },
          data: {
            status: 'REVIEWED',
            purchaseQty: need.purchaseQty ?? need.calculatedQty,
          },
        });
      }
      // Одно bulk-событие вместо N построчных: операция атомарная и
      // семантически одна («принял теорию»), а needIds в payload дают
      // достаточно следов для разбора.
      await this.audit.log(
        {
          event: 'WORKSHOP_NEEDS_ACCEPTED_CALCULATED',
          entityType: 'ORDER',
          entityId: orderId,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId,
            orderStatus: order.status,
            updated: pending.length,
            needIds: pending.map((n) => n.id),
          },
        },
        tx,
      );
    });

    this.logger.log(
      `event=workshop_need.accept_calculated order=${orderId} updated=${pending.length}`,
    );
    return { orderId, updated: pending.length };
  }

  // -------------------------------------------------------------------------
  // MANUAL ADDITION / DELETE (этап «Корректировка материалов после просчёта»)
  // -------------------------------------------------------------------------

  /**
   * Ручное добавление строки потребности (непредвиденный расход
   * материала). Разрешено только когда заказ уже на просчёте или в
   * производстве (`CALCULATION` / `CALCULATION_DONE` / `IN_PRODUCTION`) —
   * до этого состав ведётся обычным редактированием заказа, после
   * `DONE`/`CANCELLED` заказ закрыт.
   *
   * Строка создаётся с `isManual = true`, `sourceType = MANUAL_ADDITION`,
   * статусом `REVIEWED` (её завёл человек — она сразу «проверена»). На
   * себестоимость влияет только после `completeCalculation` /
   * `recalculateCostEstimate`.
   */
  async createManual(
    orderId: string,
    dto: CreateManualWorkshopNeedDto,
    actorEmployeeId?: string | null,
  ): Promise<WorkshopNeedDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'Заказ не найден',
        code: 'ORDER_NOT_FOUND',
      });
    }
    assertOrderMaterialCorrectionAllowed(order.status);

    // Фича «Варианты просчёта»: ручная строка принадлежит варианту, при
    // котором её завели (полный набор потребностей — per вариант).
    const activeCalculation = await this.prisma.orderCalculation.findFirst({
      where: { orderId, isActive: true },
      select: { id: true },
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.workshopNeed.create({
        data: {
          orderId,
          orderCalculationId: activeCalculation?.id ?? null,
          isManual: true,
          sourceType: 'MANUAL_ADDITION',
          materialRole: dto.materialRole ?? null,
          description: dto.description,
          unit: dto.unit,
          calculationMethod: 'QTY_PER_UNIT',
          status: 'REVIEWED',
          calculatedQty: new Prisma.Decimal(dto.calculatedQty),
          purchaseQty:
            dto.purchaseQty == null
              ? null
              : new Prisma.Decimal(dto.purchaseQty),
          quotedPrice:
            dto.quotedPrice == null
              ? null
              : new Prisma.Decimal(dto.quotedPrice),
          quotedCurrency: dto.quotedCurrency ?? null,
          supplierNameText: dto.supplierNameText ?? null,
          purchaseItemNameText: dto.purchaseItemNameText ?? null,
          comment: dto.comment ?? null,
        },
      });
      await this.audit.log(
        {
          event: 'WORKSHOP_NEED_MANUAL_CREATED',
          entityType: 'WORKSHOP_NEED',
          entityId: row.id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId,
            orderStatus: order.status,
            description: dto.description,
            unit: dto.unit,
            calculatedQty: dto.calculatedQty,
          },
        },
        tx,
      );
      return row;
    });

    this.logger.log(
      `event=workshop_need.manual_create id=${created.id} order=${orderId}`,
    );
    return this.getOne(created.id);
  }

  /**
   * Физическое удаление ручной строки потребности. Системные snapshot-
   * строки (`isManual = false`) удалять нельзя — для них есть только
   * `cancel` (см. `WorkshopNeedNotManualException`). Разрешено в тех же
   * статусах, что и добавление.
   */
  async deleteManual(
    id: string,
    actorEmployeeId?: string | null,
  ): Promise<void> {
    const existing = await this.prisma.workshopNeed.findUnique({
      where: { id },
      include: { order: { select: { status: true } } },
    });
    if (!existing) throw new WorkshopNeedNotFoundException();
    if (!existing.isManual) throw new WorkshopNeedNotManualException();
    assertOrderMaterialCorrectionAllowed(existing.order.status);

    await this.prisma.$transaction(async (tx) => {
      await tx.workshopNeed.delete({ where: { id } });
      await this.audit.log(
        {
          event: 'WORKSHOP_NEED_MANUAL_DELETED',
          entityType: 'WORKSHOP_NEED',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId: existing.orderId,
            description: existing.description,
          },
        },
        tx,
      );
    });
    this.logger.log(`event=workshop_need.manual_delete id=${id}`);
  }

  // -------------------------------------------------------------------------
  // АРХИВ РАСЧЁТОВ ЦЕХА (вкладка «Потребность цеха»)
  // -------------------------------------------------------------------------
  //
  // Мягкая архивация заказа ЦЕЛИКОМ из списка потребностей закупщика.
  //   - archiveOrders  — скрыть заказ(ы) из активного списка → «Архив»
  //     (`needsArchivedAt := now`). Гейт: только стадия расчёта
  //     (DRAFT/CALCULATION/CALCULATION_DONE); данные не трогаются, обратимо.
  //   - restoreOrders  — вернуть из архива (`needsArchivedAt := null`).
  //   - purgeOrders    — безвозвратно стереть просчёт заказа (все
  //     `OrderCalculation` + `WorkshopNeed`), сам заказ остаётся; только
  //     из архива и только если по строкам нет складских движений.
  //
  // Все три — bulk с частичным успехом: непрошедшие гейт заказы
  // возвращаются в `skipped` с причиной, остальные обрабатываются.
  // Точечная операция = массив из одного id; «Архивировать все» /
  // «Очистить архив» = все видимые id (собирает фронт).

  /** Статусы заказа, на которых разрешена архивация/очистка. */
  private static readonly ARCHIVABLE_ORDER_STATUSES = [
    'DRAFT',
    'CALCULATION',
    'CALCULATION_DONE',
  ];

  private async resolveActorName(
    actorEmployeeId?: string | null,
  ): Promise<string | null> {
    if (!actorEmployeeId) return null;
    const emp = await this.prisma.employee.findUnique({
      where: { id: actorEmployeeId },
      select: { fullName: true },
    });
    return emp?.fullName ?? null;
  }

  async archiveOrders(
    orderIds: string[],
    actorEmployeeId?: string | null,
  ): Promise<WorkshopNeedsArchiveResultDto> {
    const ids = Array.from(new Set(orderIds));
    const orders = await this.prisma.order.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, needsArchivedAt: true },
    });
    const byId = new Map(orders.map((o) => [o.id, o]));

    const processed: string[] = [];
    const skipped: WorkshopNeedArchiveSkipDto[] = [];
    const toArchive: string[] = [];
    for (const id of ids) {
      const order = byId.get(id);
      if (!order) {
        skipped.push({ orderId: id, reason: 'NOT_FOUND' });
        continue;
      }
      if (order.needsArchivedAt) {
        // Уже в архиве — идемпотентно считаем обработанным.
        processed.push(id);
        continue;
      }
      if (
        !WorkshopNeedsService.ARCHIVABLE_ORDER_STATUSES.includes(order.status)
      ) {
        skipped.push({ orderId: id, reason: 'NOT_ARCHIVABLE' });
        continue;
      }
      toArchive.push(id);
    }

    if (toArchive.length > 0) {
      const actorName = await this.resolveActorName(actorEmployeeId);
      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.order.updateMany({
          where: { id: { in: toArchive }, needsArchivedAt: null },
          data: {
            needsArchivedAt: now,
            needsArchivedById: actorEmployeeId ?? null,
            needsArchivedByName: actorName,
          },
        });
        await this.audit.log(
          {
            event: 'WORKSHOP_NEEDS_ORDERS_ARCHIVED',
            entityType: 'ORDER',
            entityId: toArchive[0],
            employeeId: actorEmployeeId ?? null,
            payload: { orderIds: toArchive },
          },
          tx,
        );
      });
      processed.push(...toArchive);
    }

    this.logger.log(
      `event=workshop_need.archive processed=${processed.length} skipped=${skipped.length}`,
    );
    return { processed, skipped };
  }

  async restoreOrders(
    orderIds: string[],
    actorEmployeeId?: string | null,
  ): Promise<WorkshopNeedsArchiveResultDto> {
    const ids = Array.from(new Set(orderIds));
    const orders = await this.prisma.order.findMany({
      where: { id: { in: ids } },
      select: { id: true, needsArchivedAt: true },
    });
    const byId = new Map(orders.map((o) => [o.id, o]));

    const processed: string[] = [];
    const skipped: WorkshopNeedArchiveSkipDto[] = [];
    const toRestore: string[] = [];
    for (const id of ids) {
      const order = byId.get(id);
      if (!order) {
        skipped.push({ orderId: id, reason: 'NOT_FOUND' });
        continue;
      }
      if (!order.needsArchivedAt) {
        // Не в архиве — идемпотентно считаем восстановленным.
        processed.push(id);
        continue;
      }
      toRestore.push(id);
    }

    if (toRestore.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.order.updateMany({
          where: { id: { in: toRestore } },
          data: {
            needsArchivedAt: null,
            needsArchivedById: null,
            needsArchivedByName: null,
          },
        });
        await this.audit.log(
          {
            event: 'WORKSHOP_NEEDS_ORDERS_RESTORED',
            entityType: 'ORDER',
            entityId: toRestore[0],
            employeeId: actorEmployeeId ?? null,
            payload: { orderIds: toRestore },
          },
          tx,
        );
      });
      processed.push(...toRestore);
    }

    this.logger.log(
      `event=workshop_need.restore processed=${processed.length} skipped=${skipped.length}`,
    );
    return { processed, skipped };
  }

  /**
   * Безвозвратно стереть просчёт заказа: все `OrderCalculation` + все
   * `WorkshopNeed` заказа. Сам `Order` остаётся (это чистка потребностей,
   * а не удаление заказа) — флаг архива обнуляется, заказ пропадает из
   * обеих вкладок (списки строятся из строк потребности, которых больше
   * нет). Разрешено только для архивированных заказов и только если по
   * строкам нет складских движений (иначе каскад `onDelete: Cascade`
   * снёс бы физический остаток — блокируем, как и пересчёт).
   */
  async purgeOrders(
    orderIds: string[],
    actorEmployeeId?: string | null,
  ): Promise<WorkshopNeedsArchiveResultDto> {
    const ids = Array.from(new Set(orderIds));
    const orders = await this.prisma.order.findMany({
      where: { id: { in: ids } },
      select: { id: true, needsArchivedAt: true },
    });
    const byId = new Map(orders.map((o) => [o.id, o]));

    const processed: string[] = [];
    const skipped: WorkshopNeedArchiveSkipDto[] = [];
    const toPurge: string[] = [];
    for (const id of ids) {
      const order = byId.get(id);
      if (!order) {
        skipped.push({ orderId: id, reason: 'NOT_FOUND' });
        continue;
      }
      if (!order.needsArchivedAt) {
        // Безвозвратное удаление доступно только из архива.
        skipped.push({ orderId: id, reason: 'NOT_ARCHIVED' });
        continue;
      }
      // Защита складского остатка: удаление строк с движениями каскадом
      // снесло бы StockBalance/StockMovement (см. calculateForOrder).
      const withStock = await this.prisma.workshopNeed.count({
        where: { orderId: id, stockMovements: { some: {} } },
      });
      if (withStock > 0) {
        skipped.push({ orderId: id, reason: 'HAS_STOCK' });
        continue;
      }
      toPurge.push(id);
    }

    for (const orderId of toPurge) {
      await this.prisma.$transaction(async (tx) => {
        const deletedNeeds = await tx.workshopNeed.deleteMany({
          where: { orderId },
        });
        const deletedCalcs = await tx.orderCalculation.deleteMany({
          where: { orderId },
        });
        // Заказ покидает контур потребностей: обнуляем флаг архива, чтобы
        // он не «висел» в архиве пустым и мог заново попасть в активный
        // список, если по нему когда-нибудь снова посчитают потребность.
        await tx.order.update({
          where: { id: orderId },
          data: {
            needsArchivedAt: null,
            needsArchivedById: null,
            needsArchivedByName: null,
          },
        });
        await this.audit.log(
          {
            event: 'WORKSHOP_NEEDS_ORDER_PURGED',
            entityType: 'ORDER',
            entityId: orderId,
            employeeId: actorEmployeeId ?? null,
            payload: {
              orderId,
              deletedNeeds: deletedNeeds.count,
              deletedCalculations: deletedCalcs.count,
            },
          },
          tx,
        );
      });
      processed.push(orderId);
    }

    this.logger.log(
      `event=workshop_need.purge processed=${processed.length} skipped=${skipped.length}`,
    );
    return { processed, skipped };
  }

  // -------------------------------------------------------------------------
  // CALCULATE
  // -------------------------------------------------------------------------

  async calculateForOrder(
    orderId: string,
    dto: CalculateWorkshopNeedsDto,
    actorEmployeeId?: string | null,
  ): Promise<CalculateWorkshopNeedsResultDto> {
    const force = dto.force ?? false;

    // 1. Грузим заказ + размерную матрицу + лекало с площадями + техкарту
    //    + заказные нанесения (`OrderApplication`).
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { size: true } },
        materialRequirements: { orderBy: { sortOrder: 'asc' } },
        techCard: {
          include: {
            materialLines: { orderBy: { sortOrder: 'asc' } },
          },
        },
        patternItem: {
          include: {
            materialAreas: true,
            // Этап «Фурнитура и нормы»: каждая норма
            // (`PatternItemParameterNorm`) раскрывается в отдельную
            // строку `WorkshopNeed` с `sourceType = PATTERN_PARAMETER_NORM`.
            // На MVP считаются только нормы с
            // `inputTypeSnapshot = QTY_PER_ITEM` (на текущей версии
            // только этот тип создаёт строки потребности).
            parameterNorms: true,
            // Этап «Погонные метры по размерам»: значения
            // `PatternItemSizeParameterValue` группируются по
            // `categoryParameterId`; каждый параметр даёт ОДНУ
            // строку `WorkshopNeed` с
            // `sourceType = PATTERN_SIZE_PARAMETER_VALUE`,
            // `calculatedQty = Σ(value × OrderItem.qtyPlan)` по
            // совпадающим размерам. Для одного параметра несколько
            // значений (по разным размерам) объединяются в одну
            // строку — UI показывает «1 параметр = 1 строка».
            sizeParameterValues: true,
          },
        },
        // Этап «Нанесение на заказе покупателя» (см.
        // `apps/api/src/modules/order-applications/*`,
        // `prisma/schema.prisma::OrderApplication`). На MVP
        // нанесение — отдельный «новый источник» для
        // APPLICATION-потребностей: для каждого активного
        // (не CANCELLED) `OrderApplication` сервис создаёт одну
        // строку `WorkshopNeed` с `sourceType = ORDER_APPLICATION`
        // и `materialRole = APPLICATION`. Старые
        // `TechCardOutsourceLine` остаются как legacy fallback —
        // backend на этом этапе их в потребности не превращает,
        // но и не удаляет (см. ТЗ §«Не удалять old TechCardOutsourceLine»).
        applications: {
          orderBy: { createdAt: 'asc' },
          // Адресация по размерам (этап «Нанесение по размерам»):
          // нужна для поразмерного расчёта `calculatedQty`.
          include: {
            sizes: {
              include: { size: true },
              orderBy: { size: { sortOrder: 'asc' } },
            },
          },
        },
        // Фича «Расцветки» (FEATURE_COLORWAYS): при ≥2 расцветках
        // потребность считается ПО КАЖДОЙ — своя техкарта (live-fallback,
        // если у расцветки нет строк снимка) × поразмерный план цвета
        // (`OrderVariantSize`). Снимок (`materialRequirements`) уже несёт
        // `orderVariantId`, поэтому основной путь идёт через него; live-
        // техкарта расцветки — страховка для частично-legacy снимка.
        variants: {
          orderBy: { ordinal: 'asc' },
          include: {
            techCard: {
              include: { materialLines: { orderBy: { sortOrder: 'asc' } } },
            },
            sizes: { include: { size: true } },
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    // 2. Базовые проверки.
    const totalOrderQty = order.items.reduce((s, it) => s + it.qtyPlan, 0);
    if (order.items.length === 0 || totalOrderQty <= 0) {
      throw new WorkshopNeedOrderItemsRequiredException();
    }

    // Источник материалов:
    //   - есть snapshot → ORDER_MATERIAL_REQUIREMENT (запущенный заказ
    //     или DRAFT с уже зафиксированным snapshot — соблюдаем
    //     инвариант «snapshot живёт независимо от шаблона»);
    //   - иначе live техкарта.
    const hasSnapshot = order.materialRequirements.length > 0;
    const useSnapshot = hasSnapshot;

    // Маппинг «строки снимка / строки техкарты → SourceLine». Вынесен в
    // хелперы, потому что при расцветках вызывается ОТДЕЛЬНО для каждой
    // расцветки (свой поднабор строк снимка / своя live-техкарта).
    const mapSnapshotRows = (
      rows: typeof order.materialRequirements,
    ): SourceLine[] =>
      rows.map((r) => ({
        source: 'ORDER_MATERIAL_REQUIREMENT',
        id: r.id,
        name: r.name,
        unit: r.unit,
        normUnit: r.normUnit,
        qtyPerUnit: r.qtyPerUnit,
        totalQty: r.totalQty,
        materialRole: r.materialRole,
        fabricType: r.fabricType,
        densityGsm: r.densityGsm,
        plannedWidthCm: r.plannedWidthCm,
        colorRule: r.colorRule,
        fixedColorText: r.fixedColorText,
        resolvedColorText: r.resolvedColorText,
        // Этап «Исправить формирование Потребности цеха» (см. ТЗ §5):
        // snapshot хранит дополнительные поля для фурнитуры /
        // изображения / выбора цвета — переносим их в SourceLine,
        // чтобы `computeParameterNorm` / `computeMaterialAreaByRole`
        // могли обогатить description строки потребности.
        hardwareSizeText: r.hardwareSizeText,
        hardwareMaterialText: r.hardwareMaterialText,
        characteristics:
          (r.characteristics as MaterialCharacteristics | null) ?? null,
        materialImageUrl: r.materialImageUrl,
        selectedColorText: r.selectedColorText,
        requiresColorSelection: r.requiresColorSelection,
        // Норму правили в заказе → она главнее номенклатуры (см. ниже
        // `overrideFromLine`): иначе спецификация показывала бы одно число,
        // а закупка считалась по другому.
        qtySource: r.qtySource,
        // Явная привязка к норме номенклатуры — по ней `isNormRemovedFromSpec`
        // отличает «материал есть в заказе» от «материал из заказа убрали».
        qtySourceRef: r.qtySourceRef,
      }));
    const mapTechCardLines = (
      lines: NonNullable<typeof order.techCard>['materialLines'],
    ): SourceLine[] =>
      lines.map((l) => ({
        source: 'TECH_CARD_MATERIAL_LINE',
        id: l.id,
        name: l.name,
        unit: l.unit,
        normUnit: l.normUnit,
        qtyPerUnit: l.qtyPerUnit,
        totalQty: null,
        materialRole: l.materialRole,
        fabricType: l.fabricType,
        densityGsm: l.densityGsm,
        plannedWidthCm: l.plannedWidthCm,
        colorRule: l.colorRule,
        fixedColorText: l.fixedColorText,
        resolvedColorText: null,
        hardwareSizeText: l.hardwareSizeText,
        hardwareMaterialText: l.hardwareMaterialText,
        characteristics:
          (l.characteristics as MaterialCharacteristics | null) ?? null,
        materialImageUrl: l.materialImageUrl,
        // Live-техкарта не хранит per-order selectedColorText —
        // менеджер заполняет его уже на snapshot заказа после
        // `startCalculation` (см. `OrdersService.updateMaterialRequirementColor`).
        // Для DRAFT-заказа без snapshot значение null + флаг
        // выводим из `colorRule = ORDER_SELECTED_COLOR`.
        selectedColorText: null,
        requiresColorSelection: l.colorRule === 'ORDER_SELECTED_COLOR',
        // Live-техкарта — не заказ: правки нормы в заказе тут быть не может.
        qtySource: null,
        qtySourceRef: null,
      }));

    // -----------------------------------------------------------------------
    // Фича «Расцветки» (FEATURE_COLORWAYS): строим ГРУППЫ расчёта.
    //   - ≤1 расцветки → одна order-level группа (`variantId=null`):
    //     количества из `OrderItem`, sourceLines как раньше (snapshot или
    //     live-техкарта заказа). Числа байт-в-байт как до фичи, обходит
    //     дрейф `OrderItem`↔`OrderVariantSize`.
    //   - ≥2 расцветок → группа на расцветку: количества из
    //     `OrderVariantSize`, sourceLines из строк снимка ЭТОЙ расцветки
    //     (fallback — live-техкарта расцветки/заказа для частично-legacy
    //     снимка), цвет = `variant.color`.
    // Нанесения (`OrderApplication`) считаются ОТДЕЛЬНО, один раз (ниже).
    // -----------------------------------------------------------------------
    type CalcItem = {
      sizeId: string;
      qtyPlan: number;
      size: { id: string; code: string; sortOrder: number };
    };
    type VariantGroup = {
      orderVariantId: string | null;
      variantColor: string | null;
      color: string | null;
      items: CalcItem[];
      totalQty: number;
      sourceLines: SourceLine[];
    };
    const variantGroups: VariantGroup[] =
      order.variants.length <= 1
        ? [
            {
              orderVariantId: null,
              variantColor: null,
              color: order.color,
              items: order.items.map((it) => ({
                sizeId: it.sizeId,
                qtyPlan: it.qtyPlan,
                size: it.size,
              })),
              totalQty: totalOrderQty,
              sourceLines: hasSnapshot
                ? mapSnapshotRows(order.materialRequirements)
                : mapTechCardLines(order.techCard?.materialLines ?? []),
            },
          ]
        : order.variants.map((v) => {
            const variantSnapshotRows = order.materialRequirements.filter(
              (r) => r.orderVariantId === v.id,
            );
            const sourceLines =
              variantSnapshotRows.length > 0
                ? mapSnapshotRows(variantSnapshotRows)
                : mapTechCardLines(
                    (v.techCard ?? order.techCard)?.materialLines ?? [],
                  );
            const items: CalcItem[] = v.sizes.map((s) => ({
              sizeId: s.sizeId,
              qtyPlan: s.qtyPlan,
              size: s.size,
            }));
            return {
              orderVariantId: v.id,
              variantColor: v.color,
              color: v.color,
              items,
              totalQty: items.reduce((sum, it) => sum + it.qtyPlan, 0),
              sourceLines,
            };
          });

    // -----------------------------------------------------------------------
    // Этап «Исправить формирование Потребности цеха» (см. ТЗ §2 и §3):
    // category-driven заказ — это заказ, у которого `PatternItem` имеет
    // `categoryId` И в карточке номенклатуры реально заполнены параметры
    // (нормы фурнитуры / погонные метры / площади м²). Для таких заказов
    // источник КОЛИЧЕСТВА — это параметры номенклатуры, а строки техкарты
    // используются ТОЛЬКО для обогащения описания (фабрик-тип, ширина,
    // плотность, размер фурнитуры, материал, цвет, картинка).
    //
    // Для legacy-заказов (без категории либо с категорией, но без
    // заполненных параметров) сохраняется старый расчёт «по техкарте».
    // Это нужно, чтобы исторические заказы и старые номенклатуры без
    // категорий продолжали считаться, как раньше.
    // -----------------------------------------------------------------------
    const isCategoryDriven = Boolean(
      order.patternItem?.categoryId &&
        ((order.patternItem?.parameterNorms?.length ?? 0) > 0 ||
          (order.patternItem?.sizeParameterValues?.length ?? 0) > 0 ||
          (order.patternItem?.materialAreas?.length ?? 0) > 0),
    );

    if (
      !isCategoryDriven &&
      variantGroups.every((g) => g.sourceLines.length === 0)
    ) {
      // Конструируем адресное сообщение — менеджер сразу должен
      // понять, ЧТО именно поправить, без открытия логов. Три типичных
      // случая:
      //   1) техкарта выбрана, но пустая (typical: менеджер выбрал
      //      техкарту, в которой ни одной строки `TechCardMaterialLine`);
      //   2) лекало есть, у него категория есть, но не заполнены ни
      //      площади, ни нормы фурнитуры, ни погонные метры
      //      (typical: в calc-tab оставили все ячейки м² пустыми);
      //   3) совсем ничего: ни техкарты, ни заполненного лекала.
      const hasTechCard = Boolean(order.techCardId);
      const techCardLinesEmpty =
        hasTechCard && (order.techCard?.materialLines.length ?? 0) === 0;
      const hasPattern = Boolean(order.patternItem);
      const patternHasCategory = Boolean(order.patternItem?.categoryId);
      const patternEmptyParams =
        hasPattern &&
        (order.patternItem?.materialAreas?.length ?? 0) === 0 &&
        (order.patternItem?.parameterNorms?.length ?? 0) === 0 &&
        (order.patternItem?.sizeParameterValues?.length ?? 0) === 0;

      let message: string;
      if (techCardLinesEmpty && patternEmptyParams) {
        message =
          'Расчёт не запустится: выбранная техкарта пустая (нет ни одной строки материала), и у лекала тоже не заполнены параметры. Откройте техкарту и добавьте материалы, либо откройте карточку лекала и заполните площади/нормы.';
      } else if (techCardLinesEmpty) {
        message =
          'В выбранной техкарте нет строк материалов — нечего считать. Откройте «Техкарты», добавьте в техкарту хотя бы одну строку (название, единица, норма на изделие) и попробуйте ещё раз.';
      } else if (patternHasCategory && patternEmptyParams) {
        message =
          'У лекала указана категория, но не заполнены площади материалов / нормы фурнитуры / погонные метры. Откройте карточку лекала (раздел «Номенклатура») и заполните параметры — либо привяжите к заказу техкарту со строками материалов.';
      } else if (patternEmptyParams && !patternHasCategory) {
        message =
          'У лекала не заполнены параметры (площади / нормы / погонные метры) и не задана категория. Откройте карточку лекала и добавьте параметры — либо привяжите к заказу техкарту со строками материалов.';
      } else if (!hasTechCard && !hasPattern) {
        message =
          'У заказа не привязано ни лекало, ни техкарта. Откройте заказ, выберите лекало и (опционально) техкарту, затем повторите запуск расчёта.';
      } else {
        // Fallback на исходный generic, если попали в неучтённую комбинацию.
        message =
          'Для расчёта потребности нужна техкарта со строками материалов либо лекало с заполненными параметрами.';
      }
      throw new WorkshopNeedCalculationSourceException(message);
    }

    // 2.5. Фича «Варианты просчёта»: расчёт всегда ведётся для АКТИВНОГО
    // варианта — строки штампуются его id, пересчёт удаляет/проверяет
    // только строки своей калькуляции. Строки других вариантов
    // сосуществуют и не затрагиваются. `null` (заказ без калькуляций —
    // legacy до lazy-ensure) отбирает только строки с null-штампом.
    const activeCalculation = await this.prisma.orderCalculation.findFirst({
      where: { orderId, isActive: true },
      select: { id: true },
    });
    const activeCalculationId = activeCalculation?.id ?? null;

    // 3. Идемпотентность — в рамках активной калькуляции: REVIEWED-строки
    // ДРУГОГО варианта не блокируют пересчёт этого. Sample-строки
    // (orderCalculationId=null при activeCalculationId!=null) тоже
    // больше не блокируют тиражный пересчёт и не удаляются им.
    const existing = await this.prisma.workshopNeed.findMany({
      where: { orderId, orderCalculationId: activeCalculationId },
      select: { id: true, status: true },
    });
    const hasNonCalculated = existing.some((e) => e.status !== 'CALCULATED');
    if (hasNonCalculated && !force) {
      throw new WorkshopNeedsAlreadyReviewedException();
    }

    // 4. Считаем строки в памяти.
    const warnings: string[] = [];
    const computed: ComputedNeed[] = [];
    let methodAreaDensity = 0;
    let methodQtyPerUnit = 0;

    if (!order.patternItemId) {
      warnings.push(
        'У заказа не выбрано лекало — расчёт по площади и плотности невозможен, использован fallback по норме техкарты.',
      );
    }

    // -----------------------------------------------------------------------
    // Этап «Исправить формирование Потребности цеха» (см. ТЗ §3):
    // для category-driven заказа техкартовые строки НЕ создают
    // самостоятельные `WorkshopNeed`. Они используются только в
    // helper-ах enrichment (computeMaterialAreaByRole / computeParameterNorm
    // / computeLinearBySizeParameter), чтобы подтянуть плотность,
    // ширину, размер фурнитуры, материал, картинку и цвет.
    //
    // Для legacy-заказа (без категории либо с категорией без
    // заполненных параметров) сохраняется старое поведение:
    // каждая строка техкарты / snapshot заказа становится отдельной
    // `WorkshopNeed`. Это позволяет историческим номенклатурам
    // продолжать считаться, как раньше.
    // -----------------------------------------------------------------------
    // Pattern-derived группировки — общие для всех расцветок (лекало
    // одно на заказ), поэтому строим ОДИН раз до цикла по расцветкам.
    //
    // areasByRole — площади `PatternMaterialArea` по роли материала
    // (только для category-driven; иначе AREA_DENSITY считает computeLine).
    const areasByRole = new Map<
      string,
      { sizeId: string; areaM2: Prisma.Decimal }[]
    >();
    if (isCategoryDriven) {
      for (const a of order.patternItem?.materialAreas ?? []) {
        const arr = areasByRole.get(a.materialRole) ?? [];
        arr.push({ sizeId: a.sizeId, areaM2: a.areaM2 });
        areasByRole.set(a.materialRole, arr);
      }
    }
    // linearByParam — погонные метры по размерам, сгруппированные по
    // параметру категории (см. `PatternItemSizeParameterValue`).
    const linearByParam = new Map<
      string,
      Array<{
        sizeId: string;
        value: Prisma.Decimal;
        roleKey: string;
        labelSnapshot: string;
        unit: string;
      }>
    >();
    for (const v of order.patternItem?.sizeParameterValues ?? []) {
      if (v.inputTypeSnapshot !== 'LINEAR_M_BY_SIZE') continue;
      const list = linearByParam.get(v.categoryParameterId) ?? [];
      list.push({
        sizeId: v.sizeId,
        value: v.value,
        roleKey: v.roleKey,
        labelSnapshot: v.labelSnapshot,
        unit: v.unit,
      });
      linearByParam.set(v.categoryParameterId, list);
    }
    let methodMaterialArea = 0;
    let methodLinearBySize = 0;

    // -----------------------------------------------------------------------
    // Фича «Расцветки»: считаем ПО КАЖДОЙ группе-расцветке. Внутри — те
    // же хелперы, но с per-variant количествами (`g.items`/`g.totalQty`),
    // строками источника (`g.sourceLines`) и цветом (`g.color`). Каждую
    // готовую строку ШТАМПУЕМ id/цветом расцветки (хелперы об этом не
    // знают, остаются чистыми). Для ≤1 расцветки цикл идёт один раз с
    // order-level входами → числа байт-в-байт как раньше.
    // -----------------------------------------------------------------------
    for (const g of variantGroups) {
      const stamp = (c: ComputedNeed): ComputedNeed => {
        c.orderVariantId = g.orderVariantId;
        c.variantColor = g.variantColor;
        return c;
      };

      // Legacy line-based расчёт (не category-driven): каждая строка
      // источника (снимок / техкарта расцветки) → своя потребность.
      if (!isCategoryDriven) {
        for (const line of g.sourceLines) {
          const computedLine = this.computeLine({
            line,
            order: {
              color: g.color,
              patternItemId: order.patternItemId,
            },
            items: g.items,
            materialAreas: order.patternItem?.materialAreas ?? [],
            totalOrderQty: g.totalQty,
            warnings,
          });
          if (computedLine.calculationMethod === 'AREA_DENSITY')
            methodAreaDensity++;
          else methodQtyPerUnit++;
          computed.push(stamp(computedLine));
        }
      }

      // Category-driven: AREA_M2_BY_SIZE-площади → строки напрямую из
      // `PatternMaterialArea` (по одной на materialRole), количество —
      // по поразмерному плану расцветки, обогащение — из техкарты
      // расцветки. Это убирает «лишние ткани из техкарты, под которые
      // нет площади в лекале».
      if (isCategoryDriven) {
        for (const [role, areas] of areasByRole) {
          const matchedLine = this.findEnrichmentLine({
            roleKey: role,
            labelSnapshot: null,
            sourceLines: g.sourceLines,
          });
          const computedArea = this.computeMaterialAreaByRole({
            role,
            areas,
            items: g.items,
            matchedLine,
            orderColor: g.color,
            warnings,
          });
          if (computedArea) {
            if (computedArea.calculationMethod === 'AREA_DENSITY')
              methodAreaDensity++;
            else methodQtyPerUnit++;
            methodMaterialArea++;
            computed.push(stamp(computedArea));
          }
        }
      }

      // Нормы фурнитуры (`PatternItemParameterNorm`, QTY_PER_ITEM) — по
      // одной строке на норму, количество по тиражу расцветки. Несколько
      // норм с одним roleKey НЕ схлопываются (группировка по norm.id).
      // matchedLine — обогащение из строк техкарты расцветки.
      for (const norm of order.patternItem?.parameterNorms ?? []) {
        if (norm.inputTypeSnapshot !== 'QTY_PER_ITEM') continue;
        const matchedLine = this.findEnrichmentLine({
          roleKey: norm.roleKey,
          labelSnapshot: norm.labelSnapshot,
          sourceLines: g.sourceLines,
        });
        // Материал убрали из спецификации заказа → потребности по нему нет.
        // Норма живёт в номенклатуре и одна на все заказы, поэтому без этой
        // проверки удалённая в заказе строка возвращалась в потребность на
        // ближайшем пересчёте (и менеджер видел «удалил, а оно тут»).
        if (
          this.isNormRemovedFromSpec({
            norm,
            sourceLines: g.sourceLines,
            matchedLine,
          })
        ) {
          continue;
        }
        const computedNorm = this.computeParameterNorm(
          norm,
          g.totalQty,
          matchedLine,
          g.color,
        );
        methodQtyPerUnit++;
        computed.push(stamp(computedNorm));
      }

      // Погонные метры по размерам (LINEAR_M_BY_SIZE) — одна строка на
      // параметр; `calculatedQty = Σ(value × qtyPlan)` по размерам
      // расцветки.
      for (const [categoryParameterId, values] of linearByParam) {
        const computedLinear = this.computeLinearBySizeParameter({
          categoryParameterId,
          values,
          items: g.items,
          sourceLines: g.sourceLines,
          orderColor: g.color,
          warnings,
        });
        if (computedLinear) {
          methodLinearBySize++;
          computed.push(stamp(computedLinear));
        }
      }
    }

    // Этап «Нанесение на заказе покупателя»: считаем ОДИН раз, order-level
    // (`orderVariantId = null`). Нанесение не варьируется по цвету —
    // расчёт по расцветкам дал бы двойной счёт. Для каждого активного
    // `OrderApplication` создаём одну строку `WorkshopNeed` с
    // `sourceType = ORDER_APPLICATION`, `materialRole = APPLICATION`.
    // `calculatedQty` берём из `quantity` нанесения, fallback на
    // `Σ qtyPlan` (всё изделие = одно нанесение). Поразмерный план
    // (qtyPlan по sizeId) — фоллбэк количества для нанесений,
    // адресованных на размер без явного количества.
    const sizeQtyById = new Map(
      order.items.map((it) => [it.sizeId, it.qtyPlan]),
    );
    for (const app of order.applications ?? []) {
      if (app.status === 'CANCELLED') continue;
      const computedApp = this.computeApplication(
        app,
        totalOrderQty,
        sizeQtyById,
      );
      methodQtyPerUnit++;
      computed.push(computedApp);
    }

    // Гард переполнения: `WorkshopNeed.totalAreaM2 / calculatedQty` —
    // `Decimal(14,4)`, абсолютное значение обязано быть < 10^10.
    // Произведение «расход × тираж» при нереалистичном вводе
    // (например, тираж в десятки миллионов штук или расход в тысячи
    // единиц на изделие) выходит за предел, и без этой проверки
    // Prisma уронит `numeric field overflow` → 500. Вместо этого
    // даём адресную 400 с названием позиции и числом.
    const DECIMAL_14_4_LIMIT = new Prisma.Decimal('1e10');
    for (const c of computed) {
      const overflowField =
        c.calculatedQty.abs().greaterThanOrEqualTo(DECIMAL_14_4_LIMIT)
          ? { name: 'расчётное количество', value: c.calculatedQty }
          : c.totalAreaM2 != null &&
              c.totalAreaM2.abs().greaterThanOrEqualTo(DECIMAL_14_4_LIMIT)
            ? { name: 'суммарная площадь', value: c.totalAreaM2 }
            : null;
      if (overflowField) {
        throw new WorkshopNeedCalculationOverflowException(
          `Расчёт по позиции «${c.description}» даёт слишком большое ` +
            `${overflowField.name} (${overflowField.value.toFixed(0)}). ` +
            'Проверьте план тиража по размерам и расход на изделие ' +
            '(площадь / погонные метры / норму) — скорее всего где-то ' +
            'лишний ноль.',
        );
      }
    }

    // 4.5. Защита складского остатка от каскадного удаления.
    // Пересчёт удаляет системные строки WorkshopNeed и создаёт новые с
    // другими id. По строкам, на которые уже завязаны складские движения
    // (StockBalance / StockMovement, `onDelete: Cascade`), удаление
    // снесло бы физический остаток и весь журнал движений — при том что
    // документы приёмки/расхода намеренно переживают удаление (SetNull).
    // Не даём молча стереть остаток: блокируем пересчёт с адресной 409.
    // Скоуп удаления/проверок — строки АКТИВНОЙ калькуляции (см. шаг 2.5).
    const deleteWhere = force
      ? { orderId, orderCalculationId: activeCalculationId, isManual: false }
      : {
          orderId,
          orderCalculationId: activeCalculationId,
          status: 'CALCULATED',
          isManual: false,
        };
    const needsWithStock = await this.prisma.workshopNeed.count({
      where: { ...deleteWhere, stockMovements: { some: {} } },
    });
    if (needsWithStock > 0) {
      throw new WorkshopNeedsHaveStockException();
    }

    // 5. Транзакция: удаляем нужные строки и пишем новые.
    const created = await this.prisma.$transaction(async (tx) => {
      if (force) {
        // Ручные строки (`isManual = true`, этап «Корректировка
        // материалов после просчёта») — НЕ системные, пересчёт их не
        // трогает даже в force-режиме: их завёл человек руками под
        // непредвиденный расход.
        await tx.workshopNeed.deleteMany({
          where: {
            orderId,
            orderCalculationId: activeCalculationId,
            isManual: false,
          },
        });
      } else {
        // Только CALCULATED — REVIEWED/PURCHASE_PLANNED/CANCELLED не
        // трогаем (см. ADR/ТЗ Этапа 4А). Ручные строки тоже мимо
        // (они создаются в статусе REVIEWED и с `isManual = true`).
        await tx.workshopNeed.deleteMany({
          where: {
            orderId,
            orderCalculationId: activeCalculationId,
            status: 'CALCULATED',
            isManual: false,
          },
        });
      }

      const createdRows: WorkshopNeed[] = [];
      for (const c of computed) {
        const row = await tx.workshopNeed.create({
          data: {
            orderId,
            // Фича «Варианты просчёта»: штамп активной калькуляции —
            // строка принадлежит этому варианту.
            orderCalculationId: activeCalculationId,
            // Фича «Расцветки»: привязка строки к расцветке + snapshot
            // её цвета. null — order-level (нанесение / single-variant).
            orderVariantId: c.orderVariantId ?? null,
            variantColor: c.variantColor ?? null,
            sourceType: c.sourceType,
            sourceId: c.sourceId,
            materialRole: c.materialRole,
            sourceName: c.sourceName,
            description: c.description,
            fabricType: c.fabricType,
            densityGsm: c.densityGsm,
            plannedWidthCm: c.plannedWidthCm,
            colorRule: c.colorRule,
            fixedColorText: c.fixedColorText,
            resolvedColorText: c.resolvedColorText,
            totalAreaM2: c.totalAreaM2,
            calculatedQty: c.calculatedQty,
            unit: c.unit,
            calculationMethod: c.calculationMethod,
            calculationNote: c.calculationNote,
            // status, purchaseQty и т.п. идут по дефолту: status =
            // CALCULATED, purchaseQty = null. Это и есть инвариант
            // «закупщик заполняет руками».
          },
        });
        createdRows.push(row);
      }

      // Итерация 3 «стадия per вариант»: успешный расчёт = вариант
      // отправлен на расчёт. Штамп в той же tx, что и строки —
      // инвариант «есть строки ⇔ вариант отправлен» не расходится.
      if (activeCalculationId) {
        await tx.orderCalculation.updateMany({
          where: { id: activeCalculationId, sentToCalculationAt: null },
          data: { sentToCalculationAt: new Date() },
        });
      }

      await this.audit.log(
        {
          event: 'WORKSHOP_NEEDS_CALCULATED',
          entityType: 'WORKSHOP_NEED',
          entityId: orderId,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId,
            count: createdRows.length,
            force,
            useSnapshot,
            // Этап «Исправить формирование Потребности цеха» (см.
            // ТЗ §1 source-recon): пишем в payload, был ли заказ
            // category-driven и сколько строк создано из каждого
            // источника. Это закрывает требование «понять, какие
            // строки создаются из каких источников» через журнал.
            isCategoryDriven,
            methods: {
              AREA_DENSITY: methodAreaDensity,
              QTY_PER_UNIT: methodQtyPerUnit,
              LINEAR_M_BY_SIZE: methodLinearBySize,
              PATTERN_MATERIAL_AREA: methodMaterialArea,
            },
            warningsCount: warnings.length,
          },
        },
        tx,
      );

      // Пересчёт прошёл — потребность снова совпадает со спецификацией,
      // значит отметка «устарела» снимается. В той же транзакции, что и сами
      // строки: иначе отметка и цифры разъехались бы при откате.
      await tx.order.update({
        where: { id: orderId },
        data: { needsStaleAt: null, needsStaleReason: null },
      });

      return createdRows;
    });

    this.logger.log(
      `event=workshop_needs.calculate orderId=${orderId} count=${created.length} ` +
        `force=${force} categoryDriven=${isCategoryDriven} ` +
        `methods=AREA_DENSITY:${methodAreaDensity},QTY_PER_UNIT:${methodQtyPerUnit},LINEAR_M_BY_SIZE:${methodLinearBySize},PATTERN_MATERIAL_AREA:${methodMaterialArea} ` +
        `warnings=${warnings.length}`,
    );

    // Перечитываем для DTO — нужен include на order.
    const needs = await this.list({ orderId });
    return {
      orderId,
      needs,
      count: created.length,
      force,
      methods: {
        AREA_DENSITY: methodAreaDensity,
        QTY_PER_UNIT: methodQtyPerUnit,
      },
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // SAMPLE FLOW: расчёт потребности на сигнальный образец
  // -------------------------------------------------------------------------

  /**
   * Расчёт потребности материалов для сигнального образца
   * (`OrderSample`, см. `apps/api/src/modules/order-samples/*`,
   * `docs/order-signal-sample-flow.md §«Material modes»`).
   *
   * Вызывается из `OrderSamplesService.start` ВНУТРИ той же
   * `prisma.$transaction(tx => ...)`, что и `tx.orderSample.create` +
   * `tx.passport.create`. Атомарность: если расчёт падает, образец
   * не создаётся.
   *
   * Отличия от `calculateForOrder`:
   *   - `items` подменяются на одну виртуальную строку
   *     `[{ sizeId: sample.sizeId, qtyPlan: sample.qty }]` —
   *     формулы `QTY_PER_UNIT` / `AREA_DENSITY` получают «1 единицу
   *     выбранного размера», а не весь заказ;
   *   - результирующие строки `WorkshopNeed` помечаются
   *     `orderSampleId = sample.id` — bulk-list заказа их отличит;
   *   - тиражные строки (с `orderSampleId = null`) **не трогаются**;
   *   - `OrderApplication` / `PATTERN_PARAMETER_NORM` /
   *     `PATTERN_SIZE_PARAMETER_VALUE` в sample-расчёт MVP **не
   *     включаются** — это «потребность на единицу основной ткани
   *     для пилотного отшива», не полный финансовый snapshot;
   *   - если у заказа нет ни `TechCardMaterialLine`, ни snapshot-а
   *     `OrderMaterialRequirement`, ни `PatternMaterialArea` — НЕ
   *     бросаем `WorkshopNeedCalculationSourceException` (это
   *     валидная ситуация: образец можно запустить и без техкарты,
   *     потребность тогда не пишется). В таком случае возвращаем
   *     `count = 0` и логируем warning через AuditLog.
   *
   * Возвращает количество созданных строк (для логирования из
   * `OrderSamplesService`).
   */
  async calculateForSampleInTx(
    tx: Prisma.TransactionClient,
    sample: {
      id: string;
      orderId: string;
      sizeId: string;
      qty: number;
      materialMode: string;
    },
    actorEmployeeId: string | null,
  ): Promise<{ count: number; warnings: string[] }> {
    const order = await tx.order.findUnique({
      where: { id: sample.orderId },
      include: {
        items: { include: { size: true } },
        materialRequirements: { orderBy: { sortOrder: 'asc' } },
        techCard: { include: { materialLines: { orderBy: { sortOrder: 'asc' } } } },
        patternItem: { include: { materialAreas: true } },
      },
    });
    if (!order) {
      // Не падаем — это вспомогательный шаг при создании sample;
      // отсутствие заказа должно было быть отловлено выше в
      // `OrderSamplesService.start`. Здесь — fail-soft.
      return { count: 0, warnings: ['ORDER_NOT_FOUND'] };
    }

    // Виртуальные items: одна строка по выбранному размеру с qty
    // образца. Если выбранный размер не присутствует в order.items
    // (теоретически невозможно — `OrderSamplesService.start` уже
    // валидирует), мы всё равно собираем строку из самого sample,
    // без size-record (потом обогатим через order.items при наличии).
    const sampleSizeRow = order.items.find((it) => it.sizeId === sample.sizeId);
    if (!sampleSizeRow) {
      return { count: 0, warnings: ['SAMPLE_SIZE_NOT_IN_ORDER_ITEMS'] };
    }
    const virtualItems = [
      {
        sizeId: sample.sizeId,
        qtyPlan: sample.qty,
        size: {
          id: sampleSizeRow.size.id,
          code: sampleSizeRow.size.code,
          sortOrder: sampleSizeRow.size.sortOrder,
        },
      },
    ];
    const totalSampleQty = sample.qty;

    // Источник материалов — тот же snapshot vs live tech card, что
    // и в `calculateForOrder`. Для sample мы переиспользуем тот же
    // выбор: если у заказа есть `OrderMaterialRequirement`-snapshot,
    // считаем по нему (это согласовано с тиражом); иначе — live
    // техкарта.
    //
    // ВАЖНО для sample: `OrderMaterialRequirement.totalQty` — это
    // snapshot тиражного итога (`qtyPerUnit × Σ qtyPlan`). Если
    // прокинуть его в `computeLine`, fallback QTY_PER_UNIT для
    // snapshot вернёт `line.totalQty`, и потребность будет на
    // ВЕСЬ заказ. Для sample мы хотим `qtyPerUnit × sample.qty`,
    // поэтому при копировании snapshot-строк затираем `totalQty =
    // null` — это заставит `computeLine` пересчитать через
    // `qtyPerUnit × totalOrderQty (= sample.qty)`.
    // ВАЖНО: даже для snapshot-источника мы выставляем
    // `source = 'TECH_CARD_MATERIAL_LINE'` локально, чтобы
    // `computeLine` пошёл по веткой QTY_PER_UNIT (qtyPerUnit × N),
    // а не по snapshot-ветке (line.totalQty). Snapshot нам нужен
    // лишь для enrichment (densityGsm, materialRole, цвет).
    const hasSnapshot = order.materialRequirements.length > 0;
    const sourceLines: SourceLine[] = hasSnapshot
      ? order.materialRequirements.map((r) => ({
          source: 'TECH_CARD_MATERIAL_LINE',
          id: r.id,
          name: r.name,
          unit: r.unit,
          normUnit: r.normUnit,
          qtyPerUnit: r.qtyPerUnit,
          totalQty: null,
          materialRole: r.materialRole,
          fabricType: r.fabricType,
          densityGsm: r.densityGsm,
          plannedWidthCm: r.plannedWidthCm,
          colorRule: r.colorRule,
          fixedColorText: r.fixedColorText,
          resolvedColorText: r.resolvedColorText,
          hardwareSizeText: r.hardwareSizeText,
          hardwareMaterialText: r.hardwareMaterialText,
          characteristics:
            (r.characteristics as MaterialCharacteristics | null) ?? null,
          materialImageUrl: r.materialImageUrl,
          selectedColorText: r.selectedColorText,
          requiresColorSelection: r.requiresColorSelection,
        }))
      : (order.techCard?.materialLines ?? []).map((l) => ({
          source: 'TECH_CARD_MATERIAL_LINE',
          id: l.id,
          name: l.name,
          unit: l.unit,
          normUnit: l.normUnit,
          qtyPerUnit: l.qtyPerUnit,
          totalQty: null,
          materialRole: l.materialRole,
          fabricType: l.fabricType,
          densityGsm: l.densityGsm,
          plannedWidthCm: l.plannedWidthCm,
          colorRule: l.colorRule,
          fixedColorText: l.fixedColorText,
          resolvedColorText: null,
          hardwareSizeText: l.hardwareSizeText,
          hardwareMaterialText: l.hardwareMaterialText,
          characteristics:
            (l.characteristics as MaterialCharacteristics | null) ?? null,
          materialImageUrl: l.materialImageUrl,
          selectedColorText: null,
          requiresColorSelection: l.colorRule === 'ORDER_SELECTED_COLOR',
        }));

    // Без техкарты / snapshot — sample-потребность не пишется
    // (fail-soft, см. JSDoc выше).
    if (sourceLines.length === 0) {
      await this.audit.log(
        {
          event: 'WORKSHOP_NEEDS_CALCULATED_FOR_SAMPLE',
          entityType: 'WORKSHOP_NEED',
          entityId: sample.orderId,
          employeeId: actorEmployeeId,
          payload: {
            orderId: sample.orderId,
            orderSampleId: sample.id,
            materialMode: sample.materialMode,
            sampleQty: sample.qty,
            sizeId: sample.sizeId,
            count: 0,
            note: 'NO_TECH_CARD_OR_SNAPSHOT',
            timestamp: new Date().toISOString(),
          },
        },
        tx,
      );
      return {
        count: 0,
        warnings: ['У заказа нет техкарты или snapshot материала — потребность на образец не рассчитана.'],
      };
    }

    const warnings: string[] = [];
    const computed: ComputedNeed[] = [];
    for (const line of sourceLines) {
      const c = this.computeLine({
        line,
        order: {
          color: order.color,
          patternItemId: order.patternItemId,
        },
        items: virtualItems,
        materialAreas: order.patternItem?.materialAreas ?? [],
        totalOrderQty: totalSampleQty,
        warnings,
      });
      computed.push(c);
    }

    // Пишем строки `WorkshopNeed` с `orderSampleId` — это и есть
    // отличие от тиражного `calculateForOrder` (там `orderSampleId`
    // остаётся `null`).
    for (const c of computed) {
      await tx.workshopNeed.create({
        data: {
          orderId: sample.orderId,
          orderSampleId: sample.id,
          sourceType: c.sourceType,
          sourceId: c.sourceId,
          materialRole: c.materialRole,
          sourceName: c.sourceName,
          description: c.description,
          fabricType: c.fabricType,
          densityGsm: c.densityGsm,
          plannedWidthCm: c.plannedWidthCm,
          colorRule: c.colorRule,
          fixedColorText: c.fixedColorText,
          resolvedColorText: c.resolvedColorText,
          totalAreaM2: c.totalAreaM2,
          calculatedQty: c.calculatedQty,
          unit: c.unit,
          calculationMethod: c.calculationMethod,
          calculationNote:
            (c.calculationNote ? c.calculationNote + ' · ' : '') +
            `Расчёт на сигнальный образец (qty=${sample.qty}, size=${sampleSizeRow.size.code})`,
        },
      });
    }

    await this.audit.log(
      {
        event: 'WORKSHOP_NEEDS_CALCULATED_FOR_SAMPLE',
        entityType: 'WORKSHOP_NEED',
        entityId: sample.orderId,
        employeeId: actorEmployeeId,
        payload: {
          orderId: sample.orderId,
          orderSampleId: sample.id,
          materialMode: sample.materialMode,
          sampleQty: sample.qty,
          sizeId: sample.sizeId,
          count: computed.length,
          warningsCount: warnings.length,
          timestamp: new Date().toISOString(),
        },
      },
      tx,
    );

    this.logger.log(
      `event=workshop_needs.calculate_for_sample orderId=${sample.orderId} sampleId=${sample.id} count=${computed.length} warnings=${warnings.length}`,
    );

    return { count: computed.length, warnings };
  }

  // -------------------------------------------------------------------------
  // INTERNAL: per-line computation
  // -------------------------------------------------------------------------

  private computeLine(input: {
    line: SourceLine;
    order: { color: string | null; patternItemId: string | null };
    items: { sizeId: string; qtyPlan: number; size: { id: string; code: string; sortOrder: number } }[];
    materialAreas: {
      id: string;
      sizeId: string;
      materialRole: string;
      areaM2: Prisma.Decimal;
    }[];
    totalOrderQty: number;
    warnings: string[];
  }): ComputedNeed {
    const { line, order, items, materialAreas, totalOrderQty, warnings } = input;

    const resolvedColorText = this.resolveColor(line, order.color);

    // Попытка AREA_DENSITY: нужны materialRole + densityGsm + лекало +
    // хотя бы одна совпавшая площадь.
    const canTryArea =
      Boolean(order.patternItemId) &&
      line.materialRole != null &&
      line.densityGsm != null &&
      line.densityGsm > 0;

    if (canTryArea) {
      const role = line.materialRole as string;
      const density = line.densityGsm as number;
      const matchedAreasBySize = new Map<string, Prisma.Decimal>();
      for (const a of materialAreas) {
        if (a.materialRole === role) {
          matchedAreasBySize.set(a.sizeId, a.areaM2);
        }
      }
      let totalAreaM2 = new Prisma.Decimal(0);
      const missingSizes: string[] = [];
      let coveredAtLeastOne = false;
      for (const item of items) {
        const area = matchedAreasBySize.get(item.sizeId);
        if (!area) {
          if (item.qtyPlan > 0) missingSizes.push(item.size.code);
          continue;
        }
        if (item.qtyPlan <= 0) continue;
        coveredAtLeastOne = true;
        totalAreaM2 = totalAreaM2.add(area.mul(item.qtyPlan));
      }

      if (coveredAtLeastOne) {
        // calculatedQty = totalAreaM2 × densityGsm / 1000
        const calculatedQty = totalAreaM2
          .mul(density)
          .div(1000)
          // Округляем к 4 знакам — поле Decimal(14, 4).
          .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);

        const note =
          missingSizes.length > 0
            ? `Нет площади для размеров: ${missingSizes.join(', ')} по роли ${role}. Считается только по тем размерам, где площадь задана.`
            : null;
        if (note) warnings.push(note);

        return {
          sourceType: line.source,
          sourceId: line.id,
          materialRole: line.materialRole,
          sourceName: line.name,
          description: this.buildDescription({
            method: 'AREA_DENSITY',
            line,
            resolvedColorText,
          }),
          fabricType: line.fabricType,
          densityGsm: line.densityGsm,
          plannedWidthCm: line.plannedWidthCm,
          colorRule: line.colorRule,
          fixedColorText: line.fixedColorText,
          resolvedColorText,
          totalAreaM2: totalAreaM2.toDecimalPlaces(
            4,
            Prisma.Decimal.ROUND_HALF_UP,
          ),
          calculatedQty,
          unit: 'кг',
          calculationMethod: 'AREA_DENSITY',
          calculationNote: note,
        };
      }
      // Площадей вообще нет → fallback на QTY_PER_UNIT с нотой.
      warnings.push(
        `Для строки «${line.name}» (роль ${role}) нет ни одной площади в лекале — расчёт по норме техкарты.`,
      );
    }

    // Fallback QTY_PER_UNIT.
    let calculatedQty: Prisma.Decimal;
    let unit = line.unit;
    /** Почему потребность осталась в единице нормы, а не в закупочной. */
    let conversionNote: string | null = null;
    if (line.source === 'ORDER_MATERIAL_REQUIREMENT') {
      // У snapshot totalQty посчитан в момент start() (в БД NOT NULL, так что
      // ветка `??` сегодня недостижима). Defensive (M3): если инвариант когда-
      // нибудь сломается, пересчитываем qtyPerUnit×N, как live-ветка ниже, а
      // не зануляем молча.
      calculatedQty = (line.totalQty ?? line.qtyPerUnit.mul(totalOrderQty))
        .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    } else if (needsPurchaseConversion(line.normUnit, line.unit)) {
      // Строка развела норму и закупку: `qtyPerUnit` в погонных метрах, а
      // потребность обязана выйти в закупочной единице. Считаем той же
      // формулой, что и спецификация (`computeNormPurchase` в shared), —
      // иначе экран и закупка снова разойдутся в числах.
      const converted = computeNormPurchase({
        normPerUnit: Number(line.qtyPerUnit.toString()),
        normUnit: line.normUnit,
        qty: totalOrderQty,
        purchaseUnit: line.unit,
        widthCm: line.plannedWidthCm,
        densityGsm: line.densityGsm,
      });
      if (converted.ok) {
        calculatedQty = new Prisma.Decimal(converted.purchaseQty);
      } else {
        // Пересчёт невозможен (нет ширины / плотности). Показываем расход в
        // единице НОРМЫ и говорим об этом: молчаливый ноль читается как
        // «материал не нужен», а расход в кг-подписи выдал бы длину за вес.
        calculatedQty = new Prisma.Decimal(converted.totalNorm);
        unit = normUnitOf(line);
        conversionNote = converted.message;
        warnings.push(`«${line.name}»: ${converted.message}`);
      }
    } else {
      // Live техкарта: qtyPerUnit × Σ qtyPlan.
      calculatedQty = line.qtyPerUnit
        .mul(totalOrderQty)
        .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    }

    return {
      sourceType: line.source,
      sourceId: line.id,
      materialRole: line.materialRole,
      sourceName: line.name,
      description: this.buildDescription({
        method: 'QTY_PER_UNIT',
        line,
        resolvedColorText,
      }),
      fabricType: line.fabricType,
      densityGsm: line.densityGsm,
      plannedWidthCm: line.plannedWidthCm,
      colorRule: line.colorRule,
      fixedColorText: line.fixedColorText,
      resolvedColorText,
      totalAreaM2: null,
      calculatedQty,
      unit,
      calculationMethod: 'QTY_PER_UNIT',
      calculationNote: conversionNote,
    };
  }

  /**
   * Этап «Нанесение на заказе покупателя»: per-application расчёт.
   *
   * Семантика:
   *   - `sourceType = ORDER_APPLICATION`, `sourceId = application.id`
   *     (без FK — это снимок, как и для других sourceType-ов).
   *   - `materialRole = APPLICATION` — те же роли, что использует
   *     техкартовая строка с `materialRole = APPLICATION` (из
   *     `MATERIAL_ROLES` в `@sewing/shared/material-roles`). На UI
   *     `WorkshopNeedsCard` уже умеет показывать APPLICATION как
   *     некритичную роль.
   *   - `calculatedQty = application.quantity` (если задано),
   *     иначе fallback `Σ qtyPlan` (всё изделие = одно нанесение).
   *   - `description` — человекочитаемая строка
   *     «<Тип>, <stage label>, <место>, <WxH мм>, <цвет>».
   *
   * `calculationMethod = QTY_PER_UNIT` — нанесение всегда считается
   * «по количеству», без AREA_DENSITY. Это сознательная простота
   * MVP — для нанесения площадь полотна не имеет смысла.
   */
  private computeApplication(
    app: {
      id: string;
      type: string;
      stage: string;
      placement: string | null;
      widthMm: number | null;
      heightMm: number | null;
      colorText: string | null;
      description: string | null;
      quantity: Prisma.Decimal | null;
      unit: string;
      sizes: {
        sizeId: string;
        quantity: Prisma.Decimal | null;
        size: { code: string };
      }[];
    },
    totalOrderQty: number,
    sizeQtyById: Map<string, number>,
  ): ComputedNeed {
    const type = app.type as OrderApplicationType;
    const stage = app.stage as OrderApplicationStage;
    const typeLabel =
      type in ORDER_APPLICATION_TYPE_LABELS
        ? ORDER_APPLICATION_TYPE_LABELS[type]
        : app.type;
    const stageLabel =
      stage in ORDER_APPLICATION_STAGE_LABELS
        ? ORDER_APPLICATION_STAGE_LABELS[stage]
        : app.stage;

    const parts: string[] = [typeLabel, stageLabel];
    if (app.placement) parts.push(app.placement);
    if (app.widthMm != null && app.heightMm != null) {
      parts.push(`${app.widthMm}×${app.heightMm} мм`);
    }
    if (app.colorText) parts.push(app.colorText);
    if (app.description) parts.push(app.description);

    // Адресация по размерам (этап «Нанесение по размерам»):
    //   - есть размеры → количество = Σ по размерам (на размер берём
    //     заданное `quantity` либо `qtyPlan` этого размера);
    //   - нет размеров → как раньше: order-level `quantity` либо
    //     `Σ qtyPlan` (весь тираж = одно нанесение на изделие).
    let calculatedQty: Prisma.Decimal;
    if (app.sizes.length > 0) {
      let sum = new Prisma.Decimal(0);
      const sizeParts: string[] = [];
      for (const sr of app.sizes) {
        const q =
          sr.quantity != null
            ? new Prisma.Decimal(sr.quantity)
            : new Prisma.Decimal(sizeQtyById.get(sr.sizeId) ?? 0);
        sum = sum.plus(q);
        sizeParts.push(
          sr.quantity != null ? `${sr.size.code}×${q.toString()}` : sr.size.code,
        );
      }
      calculatedQty = sum.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
      parts.push(`размеры: ${sizeParts.join(', ')}`);
    } else {
      calculatedQty = app.quantity
        ? new Prisma.Decimal(app.quantity).toDecimalPlaces(
            4,
            Prisma.Decimal.ROUND_HALF_UP,
          )
        : new Prisma.Decimal(totalOrderQty);
    }
    const description = parts.join(', ');

    return {
      sourceType: 'ORDER_APPLICATION',
      sourceId: app.id,
      materialRole: 'APPLICATION',
      sourceName: typeLabel,
      description,
      fabricType: null,
      densityGsm: null,
      plannedWidthCm: null,
      colorRule: null,
      fixedColorText: null,
      resolvedColorText: app.colorText ?? null,
      totalAreaM2: null,
      calculatedQty,
      unit: app.unit ?? 'шт',
      calculationMethod: 'QTY_PER_UNIT',
      calculationNote: null,
    };
  }

  /**
   * Этап «Фурнитура и нормы»: per-norm расчёт.
   *
   * Семантика:
   *   - `sourceType = PATTERN_PARAMETER_NORM`, `sourceId = norm.id`
   *     — каждая норма даёт отдельную строку, даже если несколько
   *     норм имеют один и тот же `roleKey` (`PACKAGING` для
   *     Люверсов / Шнура / Наконечников). См. ТЗ §8 «не группировать
   *     все PACKAGING в одну строку».
   *   - `materialRole = norm.roleKey` (snapshot — обычно `PACKAGING`,
   *     но может быть и другая роль из категорийных параметров).
   *   - `calculatedQty = qtyPerItem × totalOrderQty`,
   *     `calculationMethod = QTY_PER_UNIT`, единица — `norm.unit`.
   *   - `description` / `sourceName` — `norm.labelSnapshot` плюс
   *     обогащение из техкарты (см. ТЗ §5).
   *
   * Этап «Исправить формирование Потребности цеха» (см. ТЗ §5
   * «Enrichment для фурнитуры»): если для нормы найдена строка
   * техкарты с тем же `materialRole`, в description добавляются
   * `hardwareSizeText`, `hardwareMaterialText` и резолвленный цвет
   * (по правилу `colorRule`), а в snapshot-поля строки потребности
   * (fabricType / densityGsm / plannedWidthCm / colorRule /
   * fixedColorText / resolvedColorText) ложатся значения из
   * найденной строки. Если норма требует выбора цвета в заказе
   * (`colorRule = ORDER_SELECTED_COLOR`) и цвет ещё не указан —
   * пишем warning «Цвет нужно указать в заказе» в `calculationNote`.
   *
   * Если строки техкарты не нашли — description = labelSnapshot,
   * остальные поля null. Это значит, фурнитура нуждается в
   * закупочных деталях вручную (норма не отменяется — закупщик
   * увидит хотя бы количество и название позиции).
   */
  private computeParameterNorm(
    norm: {
      id: string;
      roleKey: string;
      labelSnapshot: string;
      unit: string;
      qtyPerItem: Prisma.Decimal;
      comment: string | null;
    },
    totalOrderQty: number,
    matchedLine: SourceLine | null,
    orderColor: string | null,
  ): ComputedNeed {
    // Норма из заказа главнее номенклатуры (см. `orderEditedNormPerUnit`).
    const editedPerItem = orderEditedNormPerUnit(matchedLine, 'qty');
    const calculatedQty = (editedPerItem ?? norm.qtyPerItem)
      .mul(totalOrderQty)
      .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);

    const resolvedColor = matchedLine
      ? this.resolveColor(matchedLine, orderColor)
      : null;

    // Description: «<labelSnapshot>, <size>, <material>, цвет <color>».
    // Каждая часть опциональна — пишем только то, что заполнено.
    const parts: string[] = [norm.labelSnapshot];
    if (matchedLine?.hardwareSizeText) {
      parts.push(matchedLine.hardwareSizeText);
    }
    if (matchedLine?.hardwareMaterialText) {
      parts.push(matchedLine.hardwareMaterialText);
    }
    if (resolvedColor) {
      parts.push(`цвет ${resolvedColor}`);
    }
    const description =
      parts.length === 1 ? parts[0] : `${parts[0]}, ${parts.slice(1).join(', ')}`;

    // Warning «Цвет нужно указать в заказе» — для строк фурнитуры с
    // правилом цвета `ORDER_SELECTED_COLOR`, у которых в snapshot
    // заказа не зафиксирован selectedColorText. UI показывает его
    // под description как secondary-warning.
    const colorMissing =
      matchedLine?.colorRule === 'ORDER_SELECTED_COLOR' && !resolvedColor;
    const noteParts: string[] = [];
    if (editedPerItem) {
      noteParts.push(
        `Норма правлена в заказе: ${editedPerItem.toString()} ${norm.unit}/шт ` +
          `(в номенклатуре ${norm.qtyPerItem.toString()}).`,
      );
    }
    if (colorMissing) noteParts.push('Цвет нужно указать в заказе');
    const calculationNote = noteParts.length > 0 ? noteParts.join(' ') : null;

    return {
      sourceType: 'PATTERN_PARAMETER_NORM',
      sourceId: norm.id,
      materialRole: norm.roleKey,
      sourceName: norm.labelSnapshot,
      description,
      fabricType: matchedLine?.fabricType ?? null,
      densityGsm: matchedLine?.densityGsm ?? null,
      plannedWidthCm: matchedLine?.plannedWidthCm ?? null,
      colorRule: matchedLine?.colorRule ?? null,
      fixedColorText: matchedLine?.fixedColorText ?? null,
      resolvedColorText: resolvedColor,
      totalAreaM2: null,
      calculatedQty,
      unit: norm.unit,
      calculationMethod: 'QTY_PER_UNIT',
      calculationNote,
    };
  }

  /**
   * Этап «Исправить формирование Потребности цеха» (см. ТЗ §3 и §6):
   * per-role расчёт AREA_M2_BY_SIZE для category-driven заказа.
   *
   * Семантика:
   *   - `sourceType = PATTERN_MATERIAL_AREA`, `sourceId = role`
   *     (одна строка потребности на одну materialRole).
   *   - `materialRole = role`, `sourceName = matchedLine.name ?? role`.
   *   - `description` обогащается из найденной строки техкарты
   *     (fabricType, density, цвет, ширина), как у legacy
   *     AREA_DENSITY-строки.
   *   - Если в техкарте есть строка с тем же materialRole
   *     и `densityGsm > 0` — потребность считается в кг по той же
   *     формуле, что и legacy AREA_DENSITY:
   *       calculatedQty = totalAreaM2 × densityGsm / 1000;
   *   - Если плотность не задана — потребность отдаётся в м² с
   *     warning, чтобы менеджер видел причину явно (а не получал
   *     ноль или ошибку).
   */
  private computeMaterialAreaByRole(input: {
    role: string;
    areas: { sizeId: string; areaM2: Prisma.Decimal }[];
    items: {
      sizeId: string;
      qtyPlan: number;
      size: { code: string };
    }[];
    matchedLine: SourceLine | null;
    orderColor: string | null;
    warnings: string[];
  }): ComputedNeed | null {
    const { role, areas, items, matchedLine, orderColor, warnings } = input;
    const areasBySize = new Map<string, Prisma.Decimal>();
    for (const a of areas) areasBySize.set(a.sizeId, a.areaM2);

    let totalAreaM2 = new Prisma.Decimal(0);
    let coveredAtLeastOne = false;
    const missingSizes: string[] = [];
    let planQty = 0;
    for (const it of items) {
      const a = areasBySize.get(it.sizeId);
      if (it.qtyPlan > 0) planQty += it.qtyPlan;
      if (!a) {
        if (it.qtyPlan > 0) missingSizes.push(it.size.code);
        continue;
      }
      if (it.qtyPlan <= 0) continue;
      coveredAtLeastOne = true;
      totalAreaM2 = totalAreaM2.add(a.mul(it.qtyPlan));
    }
    if (!coveredAtLeastOne) {
      warnings.push(
        `Для роли «${role}» нет ни одной площади на размерах заказа.`,
      );
      return null;
    }

    const noteParts: string[] = [];

    // Норма правлена в заказе (м²/шт) — считаем по ней, а не по площадям
    // лекала. Правка в других единицах (полотно в «м») площадь заменить не
    // может — тогда честно говорим об этом в примечании, а не делаем вид,
    // что закупка пошла по правке.
    const editedAreaPerUnit = orderEditedNormPerUnit(matchedLine, 'area');
    if (editedAreaPerUnit && planQty > 0) {
      const fromPattern = totalAreaM2;
      totalAreaM2 = editedAreaPerUnit
        .mul(planQty)
        .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
      noteParts.push(
        `Норма правлена в заказе: ${editedAreaPerUnit.toString()} м²/шт ` +
          `(по лекалу ${fromPattern
            .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
            .toString()} м² на тираж).`,
      );
    } else if (
      matchedLine?.qtySource === 'ORDER' &&
      !editedAreaPerUnit
    ) {
      const w = `Норма строки «${matchedLine.name}» правлена в заказе в «${normUnitOf(matchedLine)}», а потребность по роли «${role}» считается по площади лекала (м²) — правка в расчёт не вошла.`;
      noteParts.push(w);
      warnings.push(w);
    }
    if (missingSizes.length > 0) {
      const m = `Нет площади для размеров: ${missingSizes.join(', ')} по роли ${role}. Считается только по тем размерам, где площадь задана.`;
      noteParts.push(m);
      warnings.push(m);
    }

    const density = matchedLine?.densityGsm ?? null;
    const width = matchedLine?.plannedWidthCm ?? null;
    const fabricType = matchedLine?.fabricType ?? null;
    const colorRule = matchedLine?.colorRule ?? null;
    const fixedColorText = matchedLine?.fixedColorText ?? null;
    const resolvedColorText = matchedLine
      ? this.resolveColor(matchedLine, orderColor)
      : null;

    let calculatedQty: Prisma.Decimal;
    let unit: string;
    let calculationMethod: 'AREA_DENSITY' | 'QTY_PER_UNIT';
    if (density != null && density > 0) {
      calculatedQty = totalAreaM2
        .mul(density)
        .div(1000)
        .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
      unit = 'кг';
      calculationMethod = 'AREA_DENSITY';
    } else {
      // Без плотности — отдаём площадь в м². Это управленческое
      // решение: лучше показать площадь и warning, чем ноль или
      // ошибку. Закупщик увидит причину и сможет дополнить
      // плотность в техкарте либо ввести закупку вручную.
      calculatedQty = totalAreaM2.toDecimalPlaces(
        4,
        Prisma.Decimal.ROUND_HALF_UP,
      );
      unit = 'м²';
      calculationMethod = 'QTY_PER_UNIT';
      const w = `Не указана плотность материала по роли «${role}» — потребность сохранена в м² вместо кг. Заполните плотность в техкарте.`;
      noteParts.push(w);
      warnings.push(w);
    }

    // Description: «<fabricType|name> <density> г/м², <color>, ширина <w> см».
    const head = (matchedLine?.fabricType ?? matchedLine?.name ?? role).trim();
    const parts: string[] = [head];
    if (density != null) parts.push(`${density} г/м²`);
    if (resolvedColorText) parts.push(resolvedColorText);
    if (width != null) parts.push(`ширина ${width} см`);
    const description =
      parts.length === 1 ? parts[0] : `${parts[0]} ${parts.slice(1).join(', ')}`;

    if (matchedLine == null) {
      const w = `Не найдена строка техкарты для роли «${role}». Описание потребности минимальное.`;
      noteParts.push(w);
      warnings.push(w);
    }

    return {
      sourceType: 'PATTERN_MATERIAL_AREA',
      sourceId: role,
      materialRole: role,
      sourceName: matchedLine?.name ?? role,
      description,
      fabricType,
      densityGsm: density,
      plannedWidthCm: width,
      colorRule,
      fixedColorText,
      resolvedColorText,
      totalAreaM2: totalAreaM2.toDecimalPlaces(
        4,
        Prisma.Decimal.ROUND_HALF_UP,
      ),
      calculatedQty,
      unit,
      calculationMethod,
      calculationNote: noteParts.length > 0 ? noteParts.join(' ') : null,
    };
  }

  /**
   * Этап «Исправить формирование Потребности цеха» (см. ТЗ §4):
   * helper «найти строку техкарты для параметра номенклатуры».
   *
   * Алгоритм:
   *   1. exact: совпадает `materialRole = roleKey` И normalized
   *      `fabricType` или `name` техкарты совпадает с
   *      normalized(labelSnapshot);
   *   2. fallback: если в техкарте ровно одна строка с
   *      `materialRole = roleKey` — берём её;
   *   3. иначе — null (UI отрисует labelSnapshot и оставит
   *      enrichment пустым).
   *
   * `labelSnapshot` опционален: для PATTERN_MATERIAL_AREA по роли
   * мы не знаем точное имя параметра номенклатуры, и сразу падаем
   * в single-role match. Если нужно — передаём имя из категории
   * параметра (для PARAMETER_NORM это `norm.labelSnapshot`).
   *
   * normalized: trim → lowercase → collapse-spaces → ё→е. Этого
   * хватает для русского нейминга ткани / фурнитуры (Молния = молния
   * = МОЛНИЯ; Дюспа = дюспа; Тёплый = теплый).
   */
  /**
   * «Материал убрали из спецификации заказа» — норму номенклатуры не
   * превращаем в строку потребности.
   *
   * Зачем: количество для category-driven заказа берётся из номенклатуры
   * (`PatternItemParameterNorm`), а номенклатура одна на все заказы. Удаление
   * строки в конкретном заказе живёт только в его снимке
   * (`OrderMaterialRequirement`), поэтому цикл по нормам обязан спрашивать
   * снимок: иначе «Киперная лента», убранная из заказа, возвращается в
   * потребность на первом же пересчёте.
   *
   * Считаем норму УБРАННОЙ, только когда в снимке нет НИ ОДНОГО следа:
   *   1. снимок вообще есть и он привязка-совместимый — хотя бы одна строка
   *      несёт `qtySourceRef` (собран билдером, который проставляет привязки).
   *      Для legacy-снимков без привязок поведение остаётся прежним: там
   *      «нет привязки» не означает «убрали», и молча терять потребности
   *      старых заказов нельзя;
   *   2. ни одна строка не привязана к этой норме (`qtySourceRef = norm.id`);
   *   3. обогащающая строка не нашлась (`findEnrichmentLine` — по роли, имени
   *      и префиксу имени: то же правило, по которому норма и матчится);
   *   4. и ни одна строка не названа как сам параметр — страховка на случай,
   *      когда привязка не проставилась (например, из-за расхождения единиц),
   *      а роль в снимке неоднозначная.
   */
  private isNormRemovedFromSpec(input: {
    norm: { id: string; labelSnapshot: string };
    sourceLines: SourceLine[];
    matchedLine: SourceLine | null;
  }): boolean {
    const { norm, sourceLines, matchedLine } = input;
    if (matchedLine) return false;

    const fromSnapshot = sourceLines.filter(
      (l) => l.source === 'ORDER_MATERIAL_REQUIREMENT',
    );
    if (fromSnapshot.length === 0) return false;
    if (!fromSnapshot.some((l) => l.qtySourceRef)) return false;
    if (fromSnapshot.some((l) => l.qtySourceRef === norm.id)) return false;

    const normalized = (s: string | null | undefined): string =>
      (s ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/ё/g, 'е');
    const target = normalized(norm.labelSnapshot);
    if (target.length > 0) {
      const startsWith = (v: string): boolean =>
        v === target || v.startsWith(`${target} `);
      const namedLikeParam = fromSnapshot.some(
        (l) => startsWith(normalized(l.name)) || startsWith(normalized(l.fabricType)),
      );
      if (namedLikeParam) return false;
    }

    return true;
  }

  private findEnrichmentLine(input: {
    roleKey: string | null;
    labelSnapshot: string | null;
    sourceLines: SourceLine[];
  }): SourceLine | null {
    const { roleKey, labelSnapshot, sourceLines } = input;
    if (!roleKey) return null;
    const candidates = sourceLines.filter((l) => l.materialRole === roleKey);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;

    const normalized = (s: string | null | undefined): string =>
      (s ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/ё/g, 'е');

    if (labelSnapshot) {
      const target = normalized(labelSnapshot);
      if (target.length > 0) {
        for (const c of candidates) {
          if (
            normalized(c.fabricType) === target ||
            normalized(c.name) === target
          ) {
            return c;
          }
        }
        // Имя параметра — НАЧАЛО названия строки: «Молния» ↔ «Молния
        // разъёмная 60 см». Так пишут техкарты, собранные руками, и без
        // этого прохода такая строка оставалась без обогащения (описание
        // без размера/материала/цвета), а правка её нормы в заказе не
        // доезжала до закупки. Границу слова требуем обязательно, иначе
        // «Шнур» цеплял бы «Шнуровку»; берём пару, только если она
        // единственная — угадывать по-прежнему не хотим.
        const byPrefix = candidates.filter((c) => {
          const startsWith = (v: string) =>
            v === target || v.startsWith(`${target} `);
          return startsWith(normalized(c.name)) || startsWith(normalized(c.fabricType));
        });
        if (byPrefix.length === 1) return byPrefix[0]!;
      }
    }
    // Несколько строк под одну роль и нет однозначного совпадения —
    // не угадываем (см. ТЗ §4 «иначе не матчить, fallback на
    // labelSnapshot»).
    return null;
  }

  /**
   * Этап «Погонные метры по размерам» + ТЗ «Единица потребности
   * для LINEAR_M_BY_SIZE»: per-parameter расчёт.
   *
   * На вход приходит список значений по размерам для одного
   * `categoryParameterId` (`inputTypeSnapshot = LINEAR_M_BY_SIZE`).
   * Все значения относятся к одному параметру категории, поэтому
   * `roleKey/labelSnapshot/unit` берём из любой строки (snapshot
   * одинаков по построению).
   *
   * Семантика двух единиц (см. ТЗ «Исправить смысл и расчёт
   * параметров категории номенклатуры»):
   *   - В ячейках `PatternItemSizeParameterValue.value` пользователь
   *     ВСЕГДА вводит «погонные метры на изделие» (м пог.) — это
   *     semantics типа `LINEAR_M_BY_SIZE`. Поле `value.unit`
   *     (snapshot из `parameter.unit` на момент сохранения) — это
   *     «единица потребности», а НЕ единица ввода.
   *   - На основе rawLinearM = Σ(value × qtyPlan) бэкенд считает
   *     `calculatedQty` в outputUnit = `parameter.unit`:
   *       - 'м пог.' → calculatedQty = rawLinearM;
   *       - 'м²'    → calculatedQty = rawLinearM × widthCm / 100;
   *       - 'кг'    → calculatedQty = rawLinearM × widthCm / 100
   *                                   × densityGsm / 1000;
   *       - другое  → calculatedQty = rawLinearM, unit = «м пог.»,
   *                   warning «единица потребности не поддерживает
   *                   пересчёт».
   *   - widthCm / densityGsm берутся из строки техкарты заказа
   *     (`SourceLine.materialRole === parameter.roleKey`). Если
   *     строки нет — fallback на rawLinearM (м пог.) для безопасной
   *     unit «м пог.»; для outputUnit ∈ {кг, м²} строка создаётся
   *     с calculatedQty = 0 и warning, чтобы менеджер увидел
   *     проблему явно (а не получил ложное число).
   *
   * Семантика:
   *   - `sourceType = PATTERN_SIZE_PARAMETER_VALUE`,
   *     `sourceId = categoryParameterId` — один параметр = одна строка
   *     `WorkshopNeed`.
   *   - `calculationNote` собирает rawLinearM, info про конверсию
   *     и все warnings; warnings параллельно агрегируются в
   *     `result.warnings`.
   *   - `description` берётся из соответствующей строки техкарты
   *     (если есть — собираем «Кулирка 180 г/м², чёрный, ширина
   *     180 см»), иначе — `labelSnapshot`.
   */
  private computeLinearBySizeParameter(input: {
    categoryParameterId: string;
    values: Array<{
      sizeId: string;
      value: Prisma.Decimal;
      roleKey: string;
      labelSnapshot: string;
      unit: string;
    }>;
    items: { sizeId: string; qtyPlan: number; size: { code: string } }[];
    sourceLines: SourceLine[];
    orderColor: string | null;
    warnings: string[];
  }): ComputedNeed | null {
    const {
      categoryParameterId,
      values,
      items,
      sourceLines,
      orderColor,
      warnings,
    } = input;
    if (values.length === 0) return null;
    // snapshot одинаков по построению (один categoryParameterId)
    const head = values[0]!;

    const valuesBySize = new Map<string, Prisma.Decimal>();
    for (const v of values) valuesBySize.set(v.sizeId, v.value);

    let rawLinearM = new Prisma.Decimal(0);
    let coveredAtLeastOne = false;
    const missingSizes: string[] = [];
    for (const item of items) {
      const v = valuesBySize.get(item.sizeId);
      if (!v) {
        if (item.qtyPlan > 0) missingSizes.push(item.size.code);
        continue;
      }
      if (item.qtyPlan <= 0) continue;
      coveredAtLeastOne = true;
      rawLinearM = rawLinearM.add(v.mul(item.qtyPlan));
    }

    if (!coveredAtLeastOne) {
      // Ни один размер заказа не покрыт значениями — строку не
      // создаём, но даём управленческий warning.
      warnings.push(
        `Для параметра «${head.labelSnapshot}» (погонные метры) не задано ни одного значения по размерам заказа.`,
      );
      return null;
    }

    // Найдём строку техкарты / snapshot заказа по той же
    // `materialRole = roleKey` параметра. Это даёт нам ширину
    // рулона, плотность и резолвенный цвет для description.
    //
    // Этап «Исправить формирование Потребности цеха» (см. ТЗ §6
    // «Enrichment для тканей»): используем общий helper, чтобы
    // несколько техкарточных строк с одной ролью разруливались
    // консистентно с computeParameterNorm / computeMaterialAreaByRole
    // (single-role match по умолчанию, exact-match по labelSnapshot).
    const matchedLine = this.findEnrichmentLine({
      roleKey: head.roleKey,
      labelSnapshot: head.labelSnapshot,
      sourceLines,
    });
    const widthCm = matchedLine?.plannedWidthCm ?? null;
    const densityGsm = matchedLine?.densityGsm ?? null;
    // Резолвим цвет здесь, а не берём `matchedLine.resolvedColorText`
    // напрямую: для live-техкарты (DRAFT-заказ без snapshot)
    // resolvedColorText ВСЕГДА null, и без этого вызова MAIN_FABRIC
    // никогда не получал бы цвет в description до старта заказа.
    const resolvedColorText = matchedLine
      ? this.resolveColor(matchedLine, orderColor)
      : null;

    // Целевая единица — `parameter.unit` (snapshot в `value.unit`,
    // одинаковый по построению для всех значений одного параметра).
    const outputUnitRaw = (head.unit ?? '').trim();
    const outputUnit = outputUnitRaw === '' ? 'м пог.' : outputUnitRaw;

    // Норма правлена в заказе (м пог./шт) — Σ считаем по ней. Правка в
    // других единицах погонные метры не заменяет: предупреждаем явно.
    const editedLinearPerUnit = orderEditedNormPerUnit(matchedLine, 'linear');
    const planQty = items.reduce(
      (sum, it) => sum + (it.qtyPlan > 0 ? it.qtyPlan : 0),
      0,
    );
    const rawFromPattern = rawLinearM;
    if (editedLinearPerUnit && planQty > 0) {
      rawLinearM = editedLinearPerUnit
        .mul(planQty)
        .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    }

    const noteParts: string[] = [];
    noteParts.push(
      `Σ погонных метров: ${rawLinearM
        .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
        .toString()} м пог.`,
    );
    if (editedLinearPerUnit && planQty > 0) {
      noteParts.push(
        `Норма правлена в заказе: ${editedLinearPerUnit.toString()} м пог./шт ` +
          `(по номенклатуре ${rawFromPattern
            .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
            .toString()} м пог. на тираж).`,
      );
    } else if (matchedLine?.qtySource === 'ORDER' && !editedLinearPerUnit) {
      const w = `Норма строки «${matchedLine.name}» правлена в заказе в «${normUnitOf(matchedLine)}», а параметр «${head.labelSnapshot}» считается в погонных метрах — правка в расчёт не вошла.`;
      noteParts.push(w);
      warnings.push(w);
    }
    if (missingSizes.length > 0) {
      const m = `Не заполнены погонные метры для размеров: ${missingSizes.join(', ')}. Считается только по тем размерам, где значение задано.`;
      noteParts.push(m);
      warnings.push(`«${head.labelSnapshot}»: ${m}`);
    }

    let calculatedQty: Prisma.Decimal;
    let unit: string;
    let totalAreaM2: Prisma.Decimal | null = null;

    if (outputUnit === 'м пог.') {
      calculatedQty = rawLinearM.toDecimalPlaces(
        4,
        Prisma.Decimal.ROUND_HALF_UP,
      );
      unit = 'м пог.';
    } else if (outputUnit === 'м²') {
      if (widthCm == null || widthCm <= 0) {
        const w = `Не указана ширина материала для пересчёта погонных метров в м². Заполните ширину в техкарте по строке с ролью «${head.roleKey}».`;
        noteParts.push(w);
        warnings.push(`«${head.labelSnapshot}»: ${w}`);
        // Ноль «ради явной проблемы» проблему как раз и прятал: в списке
        // видно 0, а не предупреждение, и строка выпадает из закупки.
        // Показываем расход в погонных метрах — число настоящее, единица
        // честная, причина в предупреждении.
        calculatedQty = rawLinearM.toDecimalPlaces(
          4,
          Prisma.Decimal.ROUND_HALF_UP,
        );
        unit = 'м пог.';
        noteParts.push(
          'Пересчёт в м² невозможен — строка оставлена в погонных метрах.',
        );
      } else {
        const areaM2 = rawLinearM.mul(widthCm).div(100);
        totalAreaM2 = areaM2.toDecimalPlaces(
          4,
          Prisma.Decimal.ROUND_HALF_UP,
        );
        calculatedQty = areaM2.toDecimalPlaces(
          4,
          Prisma.Decimal.ROUND_HALF_UP,
        );
        unit = 'м²';
        noteParts.push(
          `Пересчёт: ${rawLinearM.toString()} м пог. × ${widthCm} см / 100 = ${calculatedQty.toString()} м².`,
        );
      }
    } else if (outputUnit === 'кг') {
      const widthMissing = widthCm == null || widthCm <= 0;
      const densityMissing = densityGsm == null || densityGsm <= 0;
      if (widthMissing || densityMissing) {
        if (widthMissing) {
          const w = `Не указана ширина материала для пересчёта погонных метров в кг. Заполните ширину в техкарте по строке с ролью «${head.roleKey}».`;
          noteParts.push(w);
          warnings.push(`«${head.labelSnapshot}»: ${w}`);
        }
        if (densityMissing) {
          const d = `Не указана плотность материала для пересчёта погонных метров в кг. Заполните плотность (г/м²) в техкарте по строке с ролью «${head.roleKey}».`;
          noteParts.push(d);
          warnings.push(`«${head.labelSnapshot}»: ${d}`);
        }
        // Пересчитать нечем — но ноль читается как «материал не нужен» и
        // молча выпадает из закупки. Показываем РЕАЛЬНЫЙ расход в погонных
        // метрах: число видно, единица честно говорит, что это не килограммы,
        // а предупреждение выше называет недостающую характеристику. Так же
        // поступает ветка неизвестной единицы ниже.
        calculatedQty = rawLinearM.toDecimalPlaces(
          4,
          Prisma.Decimal.ROUND_HALF_UP,
        );
        unit = 'м пог.';
        noteParts.push(
          'Пересчёт в кг невозможен — строка оставлена в погонных метрах.',
        );
      } else {
        const areaM2 = rawLinearM.mul(widthCm as number).div(100);
        totalAreaM2 = areaM2.toDecimalPlaces(
          4,
          Prisma.Decimal.ROUND_HALF_UP,
        );
        const kg = areaM2.mul(densityGsm as number).div(1000);
        calculatedQty = kg.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
        unit = 'кг';
        noteParts.push(
          `Пересчёт: ${rawLinearM.toString()} м пог. × ${widthCm} см / 100 × ${densityGsm} г/м² / 1000 = ${calculatedQty.toString()} кг.`,
        );
      }
    } else {
      // Неизвестная единица потребности (не из {м пог., м², кг}).
      // Безопасно: пишем rawLinearM в м пог. и сообщаем, что
      // пересчёт невозможен. Это лучше, чем выдать ноль или
      // неправильное число в неизвестной единице.
      const u = `Единица потребности «${outputUnit}» не поддерживает пересчёт из погонных метров. Сохранено как м пог.`;
      noteParts.push(u);
      warnings.push(`«${head.labelSnapshot}»: ${u}`);
      calculatedQty = rawLinearM.toDecimalPlaces(
        4,
        Prisma.Decimal.ROUND_HALF_UP,
      );
      unit = 'м пог.';
    }

    // Описание: по возможности — материал из техкарты («Кулирка
    // 180 г/м², ширина 180 см»), иначе fallback на labelSnapshot.
    const description =
      matchedLine != null
        ? this.buildDescription({
            method: 'AREA_DENSITY',
            line: matchedLine,
            resolvedColorText,
          })
        : head.labelSnapshot;

    return {
      sourceType: 'PATTERN_SIZE_PARAMETER_VALUE',
      sourceId: categoryParameterId,
      materialRole: head.roleKey,
      sourceName: head.labelSnapshot,
      description,
      fabricType: matchedLine?.fabricType ?? null,
      densityGsm: matchedLine?.densityGsm ?? null,
      plannedWidthCm: matchedLine?.plannedWidthCm ?? null,
      colorRule: matchedLine?.colorRule ?? null,
      fixedColorText: matchedLine?.fixedColorText ?? null,
      resolvedColorText,
      totalAreaM2,
      calculatedQty,
      unit,
      calculationMethod: 'LINEAR_M_BY_SIZE',
      calculationNote: noteParts.join(' '),
    };
  }

  /**
   * Для snapshot строк уже есть `resolvedColorText` (его посчитал
   * `OrdersService.start()` по `colorRule`/`Order.color`). Если он
   * пуст, мы всё равно делаем fallback по правилу — это бесплатная
   * страховка от старых snapshot-ов с null-ом.
   */
  private resolveColor(
    line: SourceLine,
    orderColor: string | null,
  ): string | null {
    if (
      line.source === 'ORDER_MATERIAL_REQUIREMENT' &&
      line.resolvedColorText &&
      line.resolvedColorText.trim() !== ''
    ) {
      return line.resolvedColorText;
    }
    const rule = line.colorRule;
    if (rule === 'ORDER_COLOR') return orderColor ?? null;
    if (rule === 'FIXED_COLOR') {
      const t = (line.fixedColorText ?? '').trim();
      return t === '' ? null : t;
    }
    // NO_COLOR / null / unknown → null.
    return null;
  }

  /**
   * Человекочитаемое описание потребности.
   *
   * AREA_DENSITY:  «<fabricType|name> <density> г/м², <color>, ширина <w> см»
   * QTY_PER_UNIT:  «<name> [<color>] [<density> г/м²] [ширина <w> см]»
   */
  private buildDescription(input: {
    method: 'AREA_DENSITY' | 'QTY_PER_UNIT';
    line: SourceLine;
    resolvedColorText: string | null;
  }): string {
    const { line, resolvedColorText } = input;
    const head = (line.fabricType ?? line.name ?? 'Материал').trim();
    const parts: string[] = [head];
    if (line.densityGsm != null) parts.push(`${line.densityGsm} г/м²`);
    if (resolvedColorText) parts.push(resolvedColorText);
    if (line.plannedWidthCm != null) {
      parts.push(`ширина ${line.plannedWidthCm} см`);
    }
    // Фаза 2 «Характеристики номенклатуры»: обогащаем описание
    // характеристиками подтипа без legacy-колонки + размер/материал
    // фурнитуры. density/rollWidth уже показаны выше — их пропускаем.
    const chars = line.characteristics ?? {};
    for (const key of [
      'type',
      'material',
      'size',
      'width',
      'thickness',
      'length',
      'holesCount',
    ]) {
      const v = chars[key];
      if (v == null || v === '') continue;
      const def = getMaterialCharacteristic(key);
      const unit = def?.unit ? ` ${def.unit}` : '';
      if (key === 'type') parts.push(`тип: ${v}`);
      else if (key === 'size') parts.push(`размер ${v}${unit}`);
      else if (key === 'length') parts.push(`длина ${v}${unit}`);
      else if (key === 'holesCount') parts.push(`${v} прокол(ов)`);
      else parts.push(`${v}${unit}`);
    }
    // Pretty-join: первая часть — «название» / «характеристика», дальше
    // через запятую. Получается «Кулирка 180 г/м², чёрный, ширина 180 см».
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts.slice(1).join(', ')}`;
  }

  // -------------------------------------------------------------------------
  // INTERNAL: supplier resolution (Этап 5)
  // -------------------------------------------------------------------------

  /**
   * Применяет правила Этапа 5 к паре `selectedSupplierId` /
   * `selectedSupplierCatalogItemId` из DTO. Возвращает «итоговое»
   * состояние пары и флаги «надо ли вообще трогать колонку».
   *
   * Контракт (см. ТЗ §6):
   *   - selectedSupplierId === undefined && selectedSupplierCatalogItemId
   *     === undefined → ничего не трогаем;
   *   - selectedSupplierId === null → очищаем supplier И catalog item
   *     (catalog item без supplier бессмыслен);
   *   - selectedSupplierId === string → проверяем exists + ACTIVE;
   *     если catalog item уже выбран и принадлежит другому поставщику,
   *     отбиваем mismatch-ом;
   *   - selectedSupplierCatalogItemId === null → очищаем только catalog
   *     item, supplier остаётся как есть;
   *   - selectedSupplierCatalogItemId === string → проверяем exists +
   *     ACTIVE; если supplier не указан — auto-set из item.supplierId;
   *     если указан — должен совпадать (mismatch ⇒ 400).
   */
  private async resolveSupplierFields(
    existing: WorkshopNeed,
    dtoSupplierId: string | null | undefined,
    dtoCatalogItemId: string | null | undefined,
  ): Promise<{
    supplierTouched: boolean;
    catalogItemTouched: boolean;
    supplierId: string | null;
    catalogItemId: string | null;
  }> {
    if (dtoSupplierId === undefined && dtoCatalogItemId === undefined) {
      return {
        supplierTouched: false,
        catalogItemTouched: false,
        supplierId: existing.selectedSupplierId,
        catalogItemId: existing.selectedSupplierCatalogItemId,
      };
    }

    // Стартовое состояние — текущие значения в БД, дальше накатываем DTO.
    let supplierId: string | null = existing.selectedSupplierId;
    let catalogItemId: string | null = existing.selectedSupplierCatalogItemId;
    let supplierTouched = false;
    let catalogItemTouched = false;

    // Шаг 1. Очистка по supplierId = null — каскадно очищает catalog item.
    if (dtoSupplierId === null) {
      supplierId = null;
      catalogItemId = null;
      supplierTouched = true;
      catalogItemTouched = true;
    } else if (typeof dtoSupplierId === 'string') {
      const supplier = await this.prisma.supplier.findUnique({
        where: { id: dtoSupplierId },
        select: { id: true, status: true },
      });
      if (!supplier) throw new SupplierNotFoundException();
      if (supplier.status !== 'ACTIVE') throw new SupplierInactiveException();
      if (supplierId !== supplier.id) {
        // При смене поставщика старый catalog item больше не валиден —
        // если DTO явно его не задаёт, очищаем.
        if (dtoCatalogItemId === undefined && catalogItemId != null) {
          catalogItemId = null;
          catalogItemTouched = true;
        }
      }
      supplierId = supplier.id;
      supplierTouched = true;
    }

    // Шаг 2. Catalog item.
    if (dtoCatalogItemId === null) {
      if (catalogItemId !== null) {
        catalogItemId = null;
        catalogItemTouched = true;
      } else if (!catalogItemTouched && dtoCatalogItemId === null) {
        // Если уже было null — всё равно отметим, что DTO явно сбрасывает,
        // чтобы аудит видел действие.
        catalogItemTouched = true;
      }
    } else if (typeof dtoCatalogItemId === 'string') {
      const item = await this.prisma.supplierCatalogItem.findUnique({
        where: { id: dtoCatalogItemId },
        select: { id: true, status: true, supplierId: true },
      });
      if (!item) throw new SupplierCatalogItemNotFoundException();
      if (item.status !== 'ACTIVE') {
        throw new SupplierCatalogItemInactiveException();
      }
      if (supplierId == null) {
        // Auto-set supplier из catalog item, если supplier не задан.
        // Параллельно валидируем, что сам поставщик ACTIVE.
        const supplier = await this.prisma.supplier.findUnique({
          where: { id: item.supplierId },
          select: { id: true, status: true },
        });
        if (!supplier) throw new SupplierNotFoundException();
        if (supplier.status !== 'ACTIVE') {
          throw new SupplierInactiveException();
        }
        supplierId = supplier.id;
        supplierTouched = true;
      } else if (supplierId !== item.supplierId) {
        throw new SupplierCatalogItemSupplierMismatchException();
      }
      catalogItemId = item.id;
      catalogItemTouched = true;
    }

    return { supplierTouched, catalogItemTouched, supplierId, catalogItemId };
  }

  // -------------------------------------------------------------------------
  // MAPPER
  // -------------------------------------------------------------------------

  private toDto(row: WorkshopNeedRowWithRelations): WorkshopNeedDto {
    const supplier = row.selectedSupplier ?? null;
    const item = row.selectedSupplierCatalogItem ?? null;
    const order = row.order ?? null;

    // -----------------------------------------------------------------------
    // Polish-итерация `/admin/workshop-needs` — `client` / `pattern` /
    // legacy `productName` resolver. Логика идентична
    // `apps/web/lib/order-nomenclature.ts::resolveOrderNomenclature` —
    // одно правило выбора во всём приложении.
    //
    // Важно: для `IN_PRODUCTION` / `CALCULATION` snapshot уже зафиксирован
    // в `OrdersService.start()` (либо в момент перевода в `CALCULATION`),
    // и UI обязан показывать именно snapshot, даже если карточку лекала
    // потом изменили. Resolver сам выбирает snapshot первым.
    // -----------------------------------------------------------------------
    const snapshotName = order?.patternNameSnapshot ?? null;
    const liveName = order?.patternItem?.name ?? null;
    const legacyProductName = order?.items?.[0]?.product?.name ?? null;

    let nomenclatureName: string | null;
    let nomenclatureArticle: string | null;
    let nomenclaturePreviewImageUrl: string | null;
    let nomenclatureSource: WorkshopNeedDto['nomenclatureSource'];
    if (snapshotName) {
      nomenclatureSource = 'snapshot';
      nomenclatureName = snapshotName;
      nomenclatureArticle =
        order?.patternArticleSnapshot ??
        order?.patternItem?.article ??
        null;
      nomenclaturePreviewImageUrl =
        order?.patternPreviewSnapshotUrl ??
        order?.patternItem?.previewImageUrl ??
        null;
    } else if (liveName) {
      nomenclatureSource = 'pattern';
      nomenclatureName = liveName;
      nomenclatureArticle = order?.patternItem?.article ?? null;
      nomenclaturePreviewImageUrl =
        order?.patternItem?.previewImageUrl ?? null;
    } else if (legacyProductName) {
      nomenclatureSource = 'legacyProduct';
      nomenclatureName = legacyProductName;
      nomenclatureArticle = null;
      nomenclaturePreviewImageUrl = null;
    } else {
      nomenclatureSource = 'none';
      nomenclatureName = null;
      nomenclatureArticle = null;
      nomenclaturePreviewImageUrl = null;
    }

    const clientId = order?.clientId ?? null;
    const clientName =
      order?.client?.name ?? order?.customer ?? null;

    const enrichment = resolveWorkshopNeedEnrichment(row);

    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber: order?.number ?? null,
      orderStatus: order?.status ?? null,
      orderDueDate: order?.dueDate ? order.dueDate.toISOString() : null,
      orderColor: order?.color ?? null,
      orderNeedsArchivedAt: order?.needsArchivedAt
        ? order.needsArchivedAt.toISOString()
        : null,
      orderNeedsArchivedByName: order?.needsArchivedByName ?? null,
      orderNeedsStaleAt: order?.needsStaleAt
        ? order.needsStaleAt.toISOString()
        : null,
      orderNeedsStaleReason: order?.needsStaleReason ?? null,
      clientId,
      clientName,
      nomenclatureName,
      nomenclatureArticle,
      nomenclaturePreviewImageUrl,
      nomenclatureSource,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      isManual: row.isManual,
      orderSampleId: row.orderSampleId,
      orderVariantId: row.orderVariantId,
      variantColor: row.variantColor,
      orderCalculationId: row.orderCalculationId,
      orderCalculationTitle: row.orderCalculation?.title ?? null,
      orderCalculationIsActive: row.orderCalculation?.isActive ?? null,
      materialRole: row.materialRole,
      sourceName: row.sourceName,
      description: row.description,
      fabricType: row.fabricType,
      densityGsm: row.densityGsm,
      plannedWidthCm: row.plannedWidthCm,
      colorRule: row.colorRule,
      fixedColorText: row.fixedColorText,
      resolvedColorText: row.resolvedColorText,
      totalAreaM2: row.totalAreaM2 ? row.totalAreaM2.toString() : null,
      calculatedQty: row.calculatedQty.toString(),
      purchaseQty: row.purchaseQty ? row.purchaseQty.toString() : null,
      packSize: row.packSize ? row.packSize.toString() : null,
      unit: row.unit,
      calculationMethod: row.calculationMethod,
      status: row.status,
      supplierNameText: row.supplierNameText,
      purchaseItemNameText: row.purchaseItemNameText,
      quotedPrice: row.quotedPrice ? row.quotedPrice.toString() : null,
      quotedCurrency: row.quotedCurrency,
      expectedDeliveryDate: row.expectedDeliveryDate
        ? row.expectedDeliveryDate.toISOString()
        : null,
      selectedSupplierId: row.selectedSupplierId,
      selectedSupplierCatalogItemId: row.selectedSupplierCatalogItemId,
      selectedSupplierName: supplier?.name ?? null,
      selectedSupplierCatalogItemName: item?.name ?? null,
      selectedSupplierCatalogItemArticle: item?.supplierArticle ?? null,
      selectedSupplierCatalogItemUnit: item?.unit ?? null,
      selectedSupplierCatalogItemLastPrice: item?.lastPrice
        ? item.lastPrice.toString()
        : null,
      comment: row.comment,
      calculationNote: row.calculationNote,
      // Этап «Исправить формирование Потребности цеха» (см. ТЗ §5–6):
      // обогащение из связанной snapshot-строки / live-техкарты.
      // Если строки не нашлось — значения null/false (UI отрисует
      // голый description без secondary-блока).
      hardwareSizeText: enrichment.hardwareSizeText,
      hardwareMaterialText: enrichment.hardwareMaterialText,
      materialImageUrl: enrichment.materialImageUrl,
      selectedColorText: enrichment.selectedColorText,
      requiresColorSelection: enrichment.requiresColorSelection,
      calculatedAt: row.calculatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/**
 * Единый include для чтения `WorkshopNeed` из БД. Использован и в
 * `list`, и в `getOne` — чтобы DTO всегда содержал одно и то же
 * (ошибки «у одного эндпоинта есть selectedSupplierName, у другого —
 * нет» исключаются на уровне типа).
 */
const WORKSHOP_NEED_INCLUDE = {
  // Polish-итерация `/admin/workshop-needs`: подтягиваем все «лёгкие»
  // поля заказа, нужные UI таблицы и группировки по заказу. Это
  // одна-таблица-через-FK select без N+1 — Prisma делает один JOIN.
  //
  // `patternItem` нужен только как fallback для DRAFT-заказов
  // (snapshot ещё не зафиксирован). Для уже запущенных заказов
  // resolver всегда выберет snapshot из самого `Order`.
  //
  // `client` — карточка из справочника `Client`; если её нет, UI
  // показывает свободный `customer` как fallback (см. resolver
  // в `toDto`).
  // Фича «Варианты просчёта»: метка варианта для закупочных экранов и
  // группировки на карточке заказа. Лёгкий select, тот же JOIN-паттерн.
  orderCalculation: {
    select: { id: true, title: true, isActive: true },
  },
  order: {
    select: {
      id: true,
      number: true,
      status: true,
      dueDate: true,
      color: true,
      customer: true,
      clientId: true,
      // Фича «Архив расчётов цеха»: снимок архивации для вкладки «Архив».
      needsArchivedAt: true,
      needsArchivedByName: true,
      needsStaleAt: true,
      needsStaleReason: true,
      patternNameSnapshot: true,
      patternArticleSnapshot: true,
      patternPreviewSnapshotUrl: true,
      client: { select: { id: true, name: true } },
      patternItem: {
        select: { id: true, name: true, article: true, previewImageUrl: true },
      },
      // Legacy `productName` fallback: ни snapshot, ни live `PatternItem`
      // не задан → берём `Product.name` из первой строки `OrderItem`
      // (исторические заказы без лекала). См. ту же стратегию в
      // `OrdersService.list` (`firstItem?.product.name`). На пилоте
      // сюда попадают только исторические заказы — для новых
      // `OrderItem.productId` указывает на «технический» Product,
      // созданный `ensureLegacyProductForPattern`, имя которого равно
      // имени `PatternItem`. То есть в нормальном flow resolver всегда
      // победит на `pattern` и сюда не дойдёт.
      items: {
        select: { product: { select: { name: true } } },
        take: 1,
      },
      // Этап «Исправить формирование Потребности цеха» (см. ТЗ §5–6,
      // §8): подтягиваем snapshot строк материала + live техкарту,
      // чтобы `toDto` мог обогатить строку потребности недостающими
      // полями (hardwareSizeText / hardwareMaterialText / materialImageUrl
      // / selectedColorText / requiresColorSelection). База WorkshopNeed
      // эти поля не хранит (см. ТЗ «Не менять Prisma»), мы их выводим
      // на чтении.
      materialRequirements: {
        select: {
          id: true,
          // Фича «Расцветки»: enrichment строк потребности обязан
          // выбирать snapshot-строку ТОЙ ЖЕ расцветки, иначе цвет /
          // картинка утекут от чужого цвета (см.
          // `resolveWorkshopNeedEnrichment`).
          orderVariantId: true,
          materialRole: true,
          name: true,
          fabricType: true,
          colorRule: true,
          hardwareSizeText: true,
          hardwareMaterialText: true,
          materialImageUrl: true,
          requiresColorSelection: true,
          selectedColorText: true,
        },
      },
      techCard: {
        select: {
          materialLines: {
            select: {
              id: true,
              materialRole: true,
              name: true,
              fabricType: true,
              colorRule: true,
              hardwareSizeText: true,
              hardwareMaterialText: true,
              materialImageUrl: true,
            },
          },
        },
      },
    },
  },
  selectedSupplier: { select: { id: true, name: true, status: true } },
  selectedSupplierCatalogItem: {
    select: {
      id: true,
      name: true,
      supplierArticle: true,
      unit: true,
      lastPrice: true,
      status: true,
      supplierId: true,
    },
  },
} as const satisfies Prisma.WorkshopNeedInclude;

type WorkshopNeedRowWithRelations = WorkshopNeed & {
  /** Фича «Варианты просчёта»: метка варианта (см. WORKSHOP_NEED_INCLUDE). */
  orderCalculation?: {
    id: string;
    title: string;
    isActive: boolean;
  } | null;
  order?: {
    id: string;
    number: string;
    status: string;
    dueDate: Date | null;
    color: string | null;
    customer: string | null;
    clientId: string | null;
    /** Фича «Архив расчётов цеха» (см. WORKSHOP_NEED_INCLUDE). */
    needsArchivedAt: Date | null;
    needsArchivedByName: string | null;
    /** Отметка «спецификация изменилась, пересчёт не прошёл». */
    needsStaleAt: Date | null;
    needsStaleReason: string | null;
    patternNameSnapshot: string | null;
    patternArticleSnapshot: string | null;
    patternPreviewSnapshotUrl: string | null;
    client: { id: string; name: string } | null;
    patternItem: {
      id: string;
      name: string;
      article: string;
      previewImageUrl: string | null;
    } | null;
    items: { product: { name: string } | null }[];
    /**
     * Этап «Исправить формирование Потребности цеха»: обогащение
     * фурнитуры / тканей данными из snapshot заказа (см. include).
     */
    materialRequirements: EnrichmentRequirementRow[];
    techCard: { materialLines: EnrichmentTechCardLineRow[] } | null;
  } | null;
  selectedSupplier?: {
    id: string;
    name: string;
    status: string;
  } | null;
  selectedSupplierCatalogItem?: {
    id: string;
    name: string;
    supplierArticle: string | null;
    unit: string;
    lastPrice: Prisma.Decimal | null;
    status: string;
    supplierId: string;
  } | null;
};

interface EnrichmentRequirementRow {
  id: string;
  /** Фича «Расцветки»: расцветка snapshot-строки (для фильтра enrichment). */
  orderVariantId: string | null;
  materialRole: string | null;
  name: string;
  fabricType: string | null;
  colorRule: string | null;
  hardwareSizeText: string | null;
  hardwareMaterialText: string | null;
  materialImageUrl: string | null;
  requiresColorSelection: boolean;
  selectedColorText: string | null;
}

interface EnrichmentTechCardLineRow {
  id: string;
  materialRole: string | null;
  name: string;
  fabricType: string | null;
  colorRule: string | null;
  hardwareSizeText: string | null;
  hardwareMaterialText: string | null;
  materialImageUrl: string | null;
}

interface ResolvedEnrichment {
  hardwareSizeText: string | null;
  hardwareMaterialText: string | null;
  materialImageUrl: string | null;
  selectedColorText: string | null;
  requiresColorSelection: boolean;
}

const EMPTY_ENRICHMENT: ResolvedEnrichment = {
  hardwareSizeText: null,
  hardwareMaterialText: null,
  materialImageUrl: null,
  selectedColorText: null,
  requiresColorSelection: false,
};

/**
 * Этап «Исправить формирование Потребности цеха» (см. ТЗ §4):
 * нормализация строк для нечувствительного к регистру / ё→е /
 * лишним пробелам сравнения. Используется и в `findEnrichmentLine`
 * на стороне расчёта, и здесь, в `resolveWorkshopNeedEnrichment`,
 * на стороне чтения DTO. Маленькая утилита, чтобы оба места ходили
 * по одному правилу.
 */
/**
 * Норма, ПРАВЛЕННАЯ В ЗАКАЗЕ, — главнее числа из номенклатуры.
 *
 * Спецификация техкарты в заказе разрешает править норму расхода (окно
 * «Материалы техкарты»). Пока потребность считала строго по номенклатуре,
 * правка была видна на экране и не доезжала до закупки — два числа про один
 * материал. Здесь единственное место, где приоритет проверяется.
 *
 * Единицы. Норма заказа осмысленна только в своей единице, поэтому вызывающий
 * передаёт `expect`: `qty` — штучная норма (совпадение с единицей параметра
 * проверять не нужно, там уже «шт»), `linear` — «м»/«м пог.», `area` — «м²».
 * Не сошлось — правку НЕ применяем и возвращаем `null`: закупку считаем по
 * номенклатуре, а расхождение показываем предупреждением (см. вызовы).
 *
 * Сверяемся с единицей НОРМЫ (`normUnit`), а не с закупочной. Это и есть та
 * развилка, из-за которой правка нормы полотна раньше никуда не доезжала:
 * строка трикотажа ведётся в «кг» (так её покупают), а норма в ней — погонные
 * метры, и сравнение с `unit` отбрасывало правку молча. У нерасщеплённых строк
 * `normUnit = null`, и поведение остаётся прежним — сверка по `unit`.
 */
/**
 * Единица, в которой ведётся норма строки: своя, если строка развела расход и
 * закупку, иначе закупочная. Одно место на все сверки — иначе легко получить
 * расчёт, где одна ветка спросила `normUnit`, а соседняя `unit`.
 */
function normUnitOf(line: SourceLine): string {
  const norm = (line.normUnit ?? '').trim();
  return norm === '' ? line.unit : norm;
}

function orderEditedNormPerUnit(
  line: SourceLine | null,
  expect: 'qty' | 'linear' | 'area',
): Prisma.Decimal | null {
  if (!line || line.qtySource !== 'ORDER') return null;
  if (line.qtyPerUnit == null || line.qtyPerUnit.lte(0)) return null;
  const unit = (normUnitOf(line) ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.\s]/g, '')
    .replace(/²/g, '2');
  if (expect === 'linear' && !(unit === 'м' || unit === 'мпог' || unit === 'мп')) {
    return null;
  }
  if (expect === 'area' && unit !== 'м2') return null;
  return line.qtyPerUnit;
}

function normalizeMatchKey(s: string | null | undefined): string {
  return (s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ё/g, 'е');
}

/**
 * Этап «Исправить формирование Потребности цеха» (см. ТЗ §5–6):
 * на чтении DTO достраиваем поля, которые `WorkshopNeed` в БД
 * не хранит (поля фурнитуры / картинка / выбранный цвет / флаг
 * требования цвета). Берём их из связанной снапшот-строки
 * `OrderMaterialRequirement` или, если snapshot ещё нет — из
 * live-строки `TechCardMaterialLine`.
 *
 * Алгоритм поиска (точно так же, как `findEnrichmentLine` в сервисе):
 *   1. Точное совпадение `sourceId` со строкой того же типа источника
 *      (`ORDER_MATERIAL_REQUIREMENT` → snapshot row;
 *      `TECH_CARD_MATERIAL_LINE` → live row).
 *   2. Иначе ищем по `materialRole` + normalized name/fabricType
 *      = normalized(sourceName).
 *   3. Иначе single-role match (если по роли ровно одна строка).
 *   4. Иначе пустое обогащение (UI покажет голый description).
 *
 * Snapshot заказа всегда предпочтительнее live-техкарты — он зафиксирован
 * в момент `OrdersService.start()` и не «уплывёт» при правке шаблона
 * после того, как заказ ушёл в производство.
 */
function resolveWorkshopNeedEnrichment(
  row: WorkshopNeedRowWithRelations,
): ResolvedEnrichment {
  const requirements = row.order?.materialRequirements ?? [];
  const techLines = row.order?.techCard?.materialLines ?? [];

  // 1. Прямое совпадение sourceId.
  if (row.sourceType === 'ORDER_MATERIAL_REQUIREMENT' && row.sourceId) {
    const r = requirements.find((x) => x.id === row.sourceId);
    if (r) return enrichmentFromRequirement(r);
  }
  if (row.sourceType === 'TECH_CARD_MATERIAL_LINE' && row.sourceId) {
    const l = techLines.find((x) => x.id === row.sourceId);
    if (l) return enrichmentFromTechCardLine(l);
  }

  // 2./3. Совпадение по материал-роли (для PATTERN_PARAMETER_NORM /
  // PATTERN_SIZE_PARAMETER_VALUE / PATTERN_MATERIAL_AREA — там
  // `sourceId` — это внутренний id параметра / роль, а не строка
  // техкарты).
  const role = row.materialRole;
  if (typeof role === 'string' && role.length > 0) {
    const target = normalizeMatchKey(row.sourceName);

    // Фича «Расцветки»: снимок строится по КАЖДОЙ расцветке, поэтому по
    // одной роли теперь несколько snapshot-строк (по числу цветов). Без
    // этого фильтра role-fallback (`length === 1` / первое совпадение)
    // утянул бы `selectedColorText` / картинку / requiresColorSelection
    // от ЧУЖОЙ расцветки. Сужаем до строк той же расцветки, что и сама
    // строка потребности (`null` order-level матчит только `null`).
    const reqMatches = requirements.filter(
      (r) =>
        r.materialRole === role &&
        r.orderVariantId === row.orderVariantId,
    );
    const reqExact = reqMatches.find(
      (r) =>
        target.length > 0 &&
        (normalizeMatchKey(r.name) === target ||
          normalizeMatchKey(r.fabricType) === target),
    );
    if (reqExact) return enrichmentFromRequirement(reqExact);
    if (reqMatches.length === 1) {
      return enrichmentFromRequirement(reqMatches[0]!);
    }
    // Тот же проход «имя параметра — начало названия строки», что и в
    // `findEnrichmentLine` на стороне расчёта: правила чтения и расчёта
    // обязаны совпадать, иначе UI покажет одно обогащение, а посчитано
    // будет по другому.
    const startsWithTarget = (v: string | null | undefined): boolean => {
      const n = normalizeMatchKey(v);
      return target.length > 0 && (n === target || n.startsWith(`${target} `));
    };
    const reqPrefix = reqMatches.filter(
      (r) => startsWithTarget(r.name) || startsWithTarget(r.fabricType),
    );
    if (reqPrefix.length === 1) return enrichmentFromRequirement(reqPrefix[0]!);

    const tlMatches = techLines.filter((l) => l.materialRole === role);
    const tlExact = tlMatches.find(
      (l) =>
        target.length > 0 &&
        (normalizeMatchKey(l.name) === target ||
          normalizeMatchKey(l.fabricType) === target),
    );
    if (tlExact) return enrichmentFromTechCardLine(tlExact);
    if (tlMatches.length === 1) {
      return enrichmentFromTechCardLine(tlMatches[0]!);
    }
    const tlPrefix = tlMatches.filter(
      (l) => startsWithTarget(l.name) || startsWithTarget(l.fabricType),
    );
    if (tlPrefix.length === 1) return enrichmentFromTechCardLine(tlPrefix[0]!);
  }

  return EMPTY_ENRICHMENT;
}

function enrichmentFromRequirement(
  r: EnrichmentRequirementRow,
): ResolvedEnrichment {
  return {
    hardwareSizeText: r.hardwareSizeText,
    hardwareMaterialText: r.hardwareMaterialText,
    materialImageUrl: r.materialImageUrl,
    selectedColorText: r.selectedColorText,
    requiresColorSelection: Boolean(r.requiresColorSelection),
  };
}

function enrichmentFromTechCardLine(
  l: EnrichmentTechCardLineRow,
): ResolvedEnrichment {
  return {
    hardwareSizeText: l.hardwareSizeText,
    hardwareMaterialText: l.hardwareMaterialText,
    materialImageUrl: l.materialImageUrl,
    selectedColorText: null,
    // На live-техкарте нет per-order selectedColorText, но если
    // правило цвета ORDER_SELECTED_COLOR — UI должен показать warning,
    // что цвет нужно указать в заказе.
    requiresColorSelection: l.colorRule === 'ORDER_SELECTED_COLOR',
  };
}

/**
 * Управленческий фильтр «Статус расчёта» → конкретный `Order.status`
 * (см. `WORKSHOP_NEED_ORDER_CALCULATION_FILTERS` в shared). `ALL`
 * из ключей исключён — он значит «не фильтровать вообще».
 *
 * `IN_PRODUCTION` / `ORDER_DONE` добавлены, чтобы закупщик видел
 * потребности запущенных и уже выпущенных заказов отдельными списками:
 * до этого они пропадали из рабочего экрана и находились только
 * под `ALL`.
 *
 * Внимание на асимметрию имён (она историческая, см. JSDoc
 * `WORKSHOP_NEED_ORDER_CALCULATION_FILTERS` в shared): `DONE` — это
 * завершённый РАСЧЁТ (`CALCULATION_DONE`), а выпущенный заказ
 * (`Order.status = DONE`) — это `ORDER_DONE`.
 *
 * `Record<...>` без `Partial` намеренно: добавление нового значения
 * фильтра в shared сразу ломает компиляцию здесь, и маппинг нельзя
 * забыть дописать.
 */
const ORDER_CALCULATION_FILTER_ORDER_STATUS: Record<
  Exclude<WorkshopNeedOrderCalculationFilter, 'ALL'>,
  OrderStatus
> = {
  ACTIVE: 'CALCULATION',
  DONE: 'CALCULATION_DONE',
  IN_PRODUCTION: 'IN_PRODUCTION',
  ORDER_DONE: 'DONE',
};

/**
 * Аккуратно объединяет существующий `where.order` с дополнительным
 * условием, не теряя того, что уже было задано. На сегодня
 * `WorkshopNeedsService.list` других `where.order`-условий не задаёт,
 * но защитный helper нужен на случай, если в будущем кто-то добавит
 * (поиск по `order.client.id`, фильтр по `dueDate` и т. п.).
 */
function mergeOrderWhere(
  current: Prisma.WorkshopNeedWhereInput['order'],
  extra: Prisma.OrderWhereInput,
): Prisma.WorkshopNeedWhereInput['order'] {
  if (!current) return extra;
  if (typeof current !== 'object') return extra;
  return { ...current, ...extra } as Prisma.WorkshopNeedWhereInput['order'];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Унифицированный «источник материала» для расчёта. Закрывает оба
 * варианта (live техкарта / snapshot заказа) одной структурой, чтобы
 * `computeLine` не разветвлял логику по источнику.
 *
 * Для live техкарты `totalQty = null` (считаем сами); для snapshot —
 * `totalQty` уже посчитан `OrdersService.start()`.
 */
interface SourceLine {
  source: 'TECH_CARD_MATERIAL_LINE' | 'ORDER_MATERIAL_REQUIREMENT';
  id: string;
  name: string;
  /** Единица ЗАКУПКИ — в ней же лежит `totalQty` и считается смета. */
  unit: string;
  /**
   * Единица НОРМЫ, если строка развела расход и закупку («м пог.» при закупке
   * в «кг»). `null` — не расщеплена, норма в `unit` (все строки до появления
   * поля). Из-за этой развилки `qtyPerUnit` и `totalQty` живут в РАЗНЫХ
   * единицах, и сравнивать `qtyPerUnit` с `unit` больше нельзя.
   */
  normUnit: string | null;
  /** Норма на изделие в `normUnit ?? unit`. */
  qtyPerUnit: Prisma.Decimal;
  totalQty: Prisma.Decimal | null;
  materialRole: string | null;
  fabricType: string | null;
  densityGsm: number | null;
  plannedWidthCm: number | null;
  colorRule: string | null;
  fixedColorText: string | null;
  /** Для snapshot — заранее посчитанный resolvedColorText. */
  resolvedColorText: string | null;
  /**
   * Этап «Исправить формирование Потребности цеха» (см. ТЗ §3, §5):
   * snapshot-копии полей строки техкарты, нужные для обогащения
   * описания фурнитуры / тканей и UI-превью изображения. На live-
   * техкарте `selectedColorText = null` и `requiresColorSelection`
   * выводится из `colorRule = ORDER_SELECTED_COLOR`. На snapshot-е
   * заказа поля приходят как есть.
   */
  hardwareSizeText: string | null;
  hardwareMaterialText: string | null;
  materialImageUrl: string | null;
  selectedColorText: string | null;
  requiresColorSelection: boolean;
  /**
   * Фаза 2 «Характеристики номенклатуры»: значения характеристик
   * подтипа для обогащения `description` (тип/размер/материал/длина/
   * толщина/ширина/кол-во проколов). null — старые строки.
   */
  characteristics: MaterialCharacteristics | null;
  /**
   * `OrderMaterialRequirement.qtySource`: `ORDER` — норму правили прямо в
   * заказе, и она главнее числа из номенклатуры. Без этого приоритета
   * спецификация показывала бы одно число, а закупка считалась по другому —
   * ровно тот разрыв, из-за которого норму и разрешили править в заказе.
   * `null` на live-техкарте (там правок заказа нет по определению).
   */
  qtySource?: string | null;
  /**
   * `OrderMaterialRequirement.qtySourceRef`: id нормы номенклатуры
   * (`PatternItemParameterNorm`), из которой строка снимка взяла число.
   * Это ЯВНАЯ привязка «строка спецификации ↔ норма»: по ней расчёт
   * понимает, что норма в заказе представлена, даже если название строки
   * не совпадает с названием параметра.
   * `null` — строка не привязана к номенклатуре (TEMPLATE/ORDER) либо
   * снимок собран до появления привязок; `undefined` — live-техкарта.
   */
  qtySourceRef?: string | null;
}

/**
 * Готовая потребность, которую сейчас положим в БД.
 *
 * `sourceType` шире, чем `SourceLine['source']`: добавляем
 * `ORDER_APPLICATION` для строк, рассчитанных по `OrderApplication`
 * (этап «Нанесение на заказе покупателя»),
 * `PATTERN_PARAMETER_NORM` для строк по нормам фурнитуры из
 * карточки лекала (этап «Фурнитура и нормы»), и
 * `PATTERN_SIZE_PARAMETER_VALUE` для строк по погонным метрам
 * (этап «Погонные метры по размерам»).
 */
interface ComputedNeed {
  sourceType:
    | 'TECH_CARD_MATERIAL_LINE'
    | 'ORDER_MATERIAL_REQUIREMENT'
    | 'ORDER_APPLICATION'
    | 'PATTERN_PARAMETER_NORM'
    | 'PATTERN_SIZE_PARAMETER_VALUE'
    /**
     * Этап «Исправить формирование Потребности цеха» (см. ТЗ §3 и §6):
     * для category-driven заказа AREA_M2_BY_SIZE рассчитывается
     * напрямую из `PatternMaterialArea` (а не из строки техкарты,
     * как раньше). Это убирает «спанбонд из техкарты, под который
     * нет заполненной площади в номенклатуре» из потребности.
     */
    | 'PATTERN_MATERIAL_AREA';
  sourceId: string;
  materialRole: string | null;
  sourceName: string | null;
  description: string;
  fabricType: string | null;
  densityGsm: number | null;
  plannedWidthCm: number | null;
  colorRule: string | null;
  fixedColorText: string | null;
  resolvedColorText: string | null;
  totalAreaM2: Prisma.Decimal | null;
  calculatedQty: Prisma.Decimal;
  unit: string;
  calculationMethod: 'AREA_DENSITY' | 'QTY_PER_UNIT' | 'LINEAR_M_BY_SIZE';
  calculationNote: string | null;
  /**
   * Фича «Расцветки»: к какой расцветке относится строка. Проставляется
   * ШТАМПОМ в per-variant цикле `calculateForOrder` (хелперы расчёта
   * остаются чистыми и их не знают). `undefined`/`null` — order-level
   * (нанесение / single-variant / legacy). `variantColor` — snapshot
   * цвета расцветки.
   */
  orderVariantId?: string | null;
  variantColor?: string | null;
}
