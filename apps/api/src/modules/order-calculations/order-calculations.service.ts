import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import {
  ORDER_CALCULATION_ERROR_CODES,
  OrderCalculationSnapshotV1Schema,
  type CreateOrderCalculationDto,
  type OrderCalculationSnapshotV1,
  type OrderCalculationsDto,
  type PricingMode,
  type RenameOrderCalculationDto,
  type UpdateOrderRouteOverridesDto,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { TIRAGE_NEED_WHERE } from '../workshop-needs/workshop-need-scope.js';
import { normalizeColor } from '@sewing/shared/colors';

/** Провалидированные ссылки снимка на справочники (см.
 *  `validateSnapshotRefs`): несуществующие FK при restore зануляются. */
interface SnapshotRefs {
  validSizeIds: Set<string>;
  validSupplierIds: Set<string>;
  validCatalogItemIds: Set<string>;
  routeTemplateId: string | null;
}

/**
 * Модуль «Варианты просчёта заказа» (флаг `FEATURE_ORDER_CALCULATIONS`).
 *
 * Дизайн «активный = живые данные» (см. JSDoc `model OrderCalculation`):
 * активный вариант не хранит данных — его состояние и есть текущие
 * данные заказа в существующих таблицах; неактивные хранят JSON-снимок
 * входов (`OrderCalculationSnapshotV1Schema`). Благодаря этому все
 * читатели системы (страницы заказа, производство, потребности,
 * себестоимость) работают по `orderId` как раньше и про варианты не
 * знают.
 *
 * Итерация 4 «расчёт per вариант»: расчёт себестоимости ЗАВЕРШАЮТ ПО
 * КАЖДОМУ варианту (`OrderCostEstimate.orderCalculationId`), а выбор
 * фиксирует ЗАПУСК В ПРОИЗВОДСТВО — до `IN_PRODUCTION` вкладки живые
 * (включая `CALCULATION_DONE` и стадию сигнального образца). Смета
 * активного варианта и есть «смета заказа», поэтому переключение
 * переносит snapshot-поля себестоимости и двигает `Order.status` между
 * `CALCULATION` и `CALCULATION_DONE` (`estimateFieldsForCalculation`) —
 * статус следует за вкладкой, и завязанный на него UI/бэк («Завершить
 * расчёт» у закупщика, окно правки, запуск в производство) работает без
 * изменений.
 *
 * Переключение (`activate`) — многошаговая операция:
 *   0) fail-fast гейты ДО любых мутаций (статус, валидность снимка и
 *      его FK-ссылок, расцветки под паспортами образца);
 *   A+B) одна транзакция: capture живого состояния в старый активный →
 *      restore снимка целевого (Order-поля, себестоимость+статус
 *      целевого варианта, расцветки, паспорта образца по цвету,
 *      параметры техкарт, снимок материалов);
 *   C) пересборка производных СУЩЕСТВУЮЩИМ путём —
 *      `OrdersService.resyncColorwayDerived` (агрегат OrderItem, снимок
 *      материалов ФАЗА-2 recompute, операционный план, снимок шагов
 *      маршрута) — БЕЗ пересчёта потребностей (`skipWorkshopNeedsRecalc`);
 *   D) оверлей route-оверрайдов ПОСЛЕ resync: carry-механика
 *      `syncOrderRouteStepsSnapshot` переносит оверрайды ПРЕДЫДУЩЕГО
 *      варианта по operationId — поэтому всем шагам пишутся значения из
 *      снимка, а отсутствующим — явные null (сброс утечки);
 *   E) потребности варианта. Итерация 2: строки `WorkshopNeed`
 *      СОСУЩЕСТВУЮТ per вариант (`orderCalculationId`) — переключение их
 *      НЕ пересчитывает и не трогает работу закупщика по другим
 *      вариантам (гейты «закупщик в работе»/склада из activate ушли).
 *      Итерация 3 «стадия per вариант»: активация ВООБЩЕ ничего не
 *      считает — вариант-черновик (`sentToCalculationAt = null`)
 *      рассчитывается только явной кнопкой («Перевести в расчёт» /
 *      «Рассчитать вариант» → `OrdersService.startCalculation`, ветка
 *      isVariantCalc). Здесь только ре-линк строк варианта к
 *      пересозданным расцветкам (по `variantColor`).
 *
 * Инвариант устойчивости: фазы C–E идут отдельными транзакциями. Сбой в
 * середине оставляет данные КОНСИСТЕНТНЫМИ (входы уже переключены), но
 * недосинхронизированными — повторный `activate` того же варианта
 * (no-op по входам) или любая правка расцветки самолечит производные
 * через тот же resync.
 *
 * Осознанные ограничения: `OrderExtraCost`, `OrderApplication`,
 * `OrderLogisticsLine` — order-level и общие для всех вариантов;
 * реальная закупка (PO) разрешена только под строки активного варианта
 * (гейт в `PurchaseOrdersService.createFromNeeds`).
 */
@Injectable()
export class OrderCalculationsService {
  private static readonly log = new Logger(OrderCalculationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // READ
  // -------------------------------------------------------------------------

  async listForOrder(orderId: string): Promise<OrderCalculationsDto> {
    const order = await this.getOrderOrThrow(orderId);
    await this.ensureBaseline(orderId, order.costEstimateTotalRub);

    const rows = await this.prisma.orderCalculation.findMany({
      where: { orderId },
      orderBy: { ordinal: 'asc' },
      select: {
        id: true,
        ordinal: true,
        title: true,
        isActive: true,
        costTotalRub: true,
        sentToCalculationAt: true,
        updatedAt: true,
      },
    });
    const active = rows.find((r) => r.isActive) ?? rows[0];

    // «Расчёт завершён» — стадия ВАРИАНТА, а не заказа: у каждого своя
    // смета. Legacy-сметы без `orderCalculationId` (до бэкфилла)
    // считаем принадлежащими активной вкладке — ровно как их видит
    // `ACTIVE_CALCULATION_ESTIMATE_WHERE`.
    const estimates = await this.prisma.orderCostEstimate.findMany({
      where: { orderId, status: 'COMPLETED' },
      orderBy: { version: 'desc' },
      select: { orderCalculationId: true, completedAt: true },
    });
    const completedAtByCalc = new Map<string, Date>();
    for (const e of estimates) {
      const calcId = e.orderCalculationId ?? active.id;
      if (!completedAtByCalc.has(calcId)) {
        completedAtByCalc.set(calcId, e.completedAt);
      }
    }

    return {
      orderId,
      activeId: active.id,
      canSwitch: this.isEditableStatus(order.status),
      items: rows.map((r) => ({
        id: r.id,
        ordinal: r.ordinal,
        title: r.title,
        isActive: r.isActive,
        costEstimateCompletedAt:
          completedAtByCalc.get(r.id)?.toISOString() ?? null,
        // Активная вкладка показывает ЖИВУЮ себестоимость заказа,
        // неактивные — снимок на момент переключения.
        costTotalRub: r.isActive
          ? (order.costEstimateTotalRub?.toString() ?? null)
          : (r.costTotalRub?.toString() ?? null),
        sentToCalculationAt: r.sentToCalculationAt?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // WRITE
  // -------------------------------------------------------------------------

  /**
   * «+ Вариант просчёта»: клонирует АКТИВНЫЙ вариант. Клон = живые
   * данные, поэтому restore не нужен: старый активный получает снимок
   * текущего состояния, новая калькуляция становится активной с
   * `snapshot = null`. Живые таблицы заказа не меняются вовсе.
   */
  async create(
    orderId: string,
    dto: CreateOrderCalculationDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderCalculationsDto> {
    const order = await this.getOrderOrThrow(orderId);
    this.assertEditableStatus(order.status);
    await this.ensureBaseline(orderId, order.costEstimateTotalRub);

    const rows = await this.prisma.orderCalculation.findMany({
      where: { orderId },
      select: { id: true, ordinal: true, isActive: true },
    });
    const active = rows.find((r) => r.isActive);
    if (!active) {
      // ensureBaseline гарантирует активную; сюда можно попасть только
      // при гонке с параллельным activate — честный 409.
      throw this.conflict(
        ORDER_CALCULATION_ERROR_CODES.CONFLICT,
        'Варианты просчёта изменяются параллельно — обновите страницу и повторите.',
      );
    }
    const nextOrdinal = Math.max(...rows.map((r) => r.ordinal)) + 1;
    const title = dto.title?.trim() || `Вариант ${nextOrdinal + 1}`;

    await this.prisma.$transaction(async (tx) => {
      const snapshot = await this.captureSnapshot(tx, orderId);
      const captured = await tx.orderCalculation.updateMany({
        where: { id: active.id, isActive: true },
        data: {
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          isActive: false,
          costTotalRub: order.costEstimateTotalRub,
        },
      });
      if (captured.count !== 1) {
        throw this.conflict(
          ORDER_CALCULATION_ERROR_CODES.CONFLICT,
          'Варианты просчёта изменяются параллельно — обновите страницу и повторите.',
        );
      }
      const created = await tx.orderCalculation.create({
        data: { orderId, ordinal: nextOrdinal, title, isActive: true },
        select: { id: true },
      });
      // Клон рождается БЕЗ сметы: расчёт завершают по каждому варианту.
      // Снимаем с заказа себестоимость прежней вкладки и возвращаем
      // статус в «Расчёт» — иначе новый вариант показывал бы чужие
      // деньги и считался бы рассчитанным.
      await tx.order.update({
        where: { id: orderId },
        data: await this.estimateFieldsForCalculation(
          tx,
          orderId,
          created.id,
          order.status,
        ),
      });
      await this.audit.log(
        {
          event: 'ORDER_CALCULATION_CREATED',
          entityType: 'ORDER',
          entityId: orderId,
          payload: { calculationId: created.id, ordinal: nextOrdinal, title },
          employeeId: actorEmployeeId ?? null,
        },
        tx,
      );
    });

    // Итерация 3 «стадия per вариант»: клон рождается ЧЕРНОВИКОМ
    // (sentToCalculationAt = null) — его потребности НЕ считаются
    // автоматически даже на заказе в CALCULATION. Менеджер отправляет
    // вариант на расчёт явной кнопкой (OrdersService.startCalculation,
    // ветка isVariantCalc). Строки WorkshopNeed остались у прежнего
    // активного варианта и продолжают жить.

    return this.listForOrder(orderId);
  }

  /**
   * Переключение активного варианта. Полная семантика — в JSDoc класса.
   */
  async activate(
    orderId: string,
    calcId: string,
    actorEmployeeId?: string | null,
  ): Promise<OrderCalculationsDto> {
    const order = await this.getOrderOrThrow(orderId);
    const target = await this.prisma.orderCalculation.findFirst({
      where: { id: calcId, orderId },
    });
    if (!target) throw this.notFoundCalc();
    if (target.isActive) return this.listForOrder(orderId); // no-op

    // --- Фаза 0: fail-fast гейты до любых мутаций -------------------------
    // Итерация 2 (потребности per вариант): гейты «закупщик в работе» и
    // складской из activate УБРАНЫ — переключение больше не пересчитывает
    // и не удаляет ничьи строки WorkshopNeed (см. фазу E).
    this.assertEditableStatus(order.status);

    const parsed = OrderCalculationSnapshotV1Schema.safeParse(target.snapshot);
    if (!parsed.success) {
      throw this.conflict(
        ORDER_CALCULATION_ERROR_CODES.SNAPSHOT_INVALID,
        'Снимок этого варианта повреждён или несовместим с текущей версией системы — переключение невозможно.',
      );
    }
    const snap = parsed.data;
    const refs = await this.validateSnapshotRefs(snap);

    // Гейт стадии сигнального образца (переключение доступно вплоть до
    // запуска в производство): restore пересоздаёт `OrderVariant`, а
    // `Passport.orderVariantId` уходит в SetNull. Паспорта переносим на
    // расцветки целевого варианта ПО ЦВЕТУ; если цвета там нет —
    // честная 409 до любых мутаций, а не паспорт без расцветки.
    const passportLinks = await this.passportVariantLinks(orderId);
    const targetColors = new Set(
      snap.variants.map((v) => normalizeColor(v.color)),
    );
    const lostColors = [
      ...new Set(
        passportLinks
          .filter((p) => !targetColors.has(normalizeColor(p.color)))
          .map((p) => p.color),
      ),
    ];
    if (lostColors.length > 0) {
      throw this.conflict(
        ORDER_CALCULATION_ERROR_CODES.PASSPORTS_COLOR_MISMATCH,
        `По заказу уже есть паспорта расцветк${lostColors.length === 1 ? 'и' : 'ок'} «${lostColors.join('», «')}», а в варианте «${target.title}» так${lostColors.length === 1 ? 'ой расцветки' : 'их расцветок'} нет — переключение оставило бы паспорта без расцветки. Добавьте расцветку в вариант или отмените образец.`,
      );
    }

    // --- Фазы A+B: capture + restore в одной транзакции -------------------
    await this.prisma.$transaction(async (tx) => {
      const currentSnapshot = await this.captureSnapshot(tx, orderId);
      const captured = await tx.orderCalculation.updateMany({
        where: { orderId, isActive: true, id: { not: target.id } },
        data: {
          snapshot: currentSnapshot as unknown as Prisma.InputJsonValue,
          isActive: false,
          costTotalRub: order.costEstimateTotalRub,
        },
      });
      if (captured.count !== 1) {
        throw this.conflict(
          ORDER_CALCULATION_ERROR_CODES.CONFLICT,
          'Варианты просчёта изменяются параллельно — обновите страницу и повторите.',
        );
      }

      // Order-поля варианта. OrderItem не трогаем — его пересоберёт
      // resyncColorwayDerived из расцветок.
      await tx.order.update({
        where: { id: orderId },
        data: {
          routeTemplateId: refs.routeTemplateId,
          color: snap.order.color,
          customerUnitPrice: snap.order.customerUnitPrice,
          customerCurrency: snap.order.customerCurrency,
          materialsAndHardwareCostPolicy:
            snap.order.materialsAndHardwareCostPolicy,
          patternDevelopmentCostRub: snap.order.patternDevelopmentCostRub,
          patternDevelopmentCostInCostPrice:
            snap.order.patternDevelopmentCostInCostPrice,
          // Себестоимость и статус расчёта — тоже свойство ВАРИАНТА
          // (расчёт завершают по каждому). Переносим snapshot-поля на
          // смету целевого варианта в той же транзакции.
          ...(await this.estimateFieldsForCalculation(
            tx,
            orderId,
            target.id,
            order.status,
          )),
        },
      });

      // Расцветки: полная замена (cascade сносит sizes и variant-scoped
      // параметры; OrderMaterialRequirement/WorkshopNeed уходят в SetNull
      // и тут же пересоздаются ниже / в resync).
      await tx.orderVariant.deleteMany({ where: { orderId } });
      const variantIdByOrdinal = new Map<number, string>();
      for (const v of snap.variants) {
        const created = await tx.orderVariant.create({
          data: {
            orderId,
            ordinal: v.ordinal,
            color: v.color,
            sizes: {
              create: this.normalizeSizes(v.sizes).filter((s) =>
                refs.validSizeIds.has(s.sizeId),
              ),
            },
          },
          select: { id: true },
        });
        variantIdByOrdinal.set(v.ordinal, created.id);
      }

      // Паспорта (сигнальный образец) — восстанавливаем расцветку по
      // цвету: `deleteMany` выше увёл `Passport.orderVariantId` в
      // SetNull. Гейт фазы 0 гарантирует, что цвет в целевом варианте
      // есть, поэтому паспорт без расцветки здесь не остаётся.
      if (passportLinks.length > 0) {
        const variantIdByColor = new Map<string, string>();
        for (const v of snap.variants) {
          const key = normalizeColor(v.color);
          const created = variantIdByOrdinal.get(v.ordinal);
          if (created && !variantIdByColor.has(key)) {
            variantIdByColor.set(key, created);
          }
        }
        const passportIdsByColor = new Map<string, string[]>();
        for (const link of passportLinks) {
          const key = normalizeColor(link.color);
          const list = passportIdsByColor.get(key) ?? [];
          list.push(link.passportId);
          passportIdsByColor.set(key, list);
        }
        for (const [key, ids] of passportIdsByColor) {
          const variantId = variantIdByColor.get(key);
          if (!variantId) continue;
          await tx.passport.updateMany({
            where: { id: { in: ids } },
            data: { orderVariantId: variantId },
          });
        }
      }

      // Параметры техкарт варианта (значения + ad-hoc определения).
      await tx.orderTechCardParameter.deleteMany({ where: { orderId } });
      const paramRows = snap.techCardParameters
        .filter(
          (p) =>
            p.variantOrdinal == null ||
            variantIdByOrdinal.has(p.variantOrdinal),
        )
        .map((p) => ({
          orderId,
          orderVariantId:
            p.variantOrdinal == null
              ? null
              : variantIdByOrdinal.get(p.variantOrdinal)!,
          key: p.key,
          label: p.label,
          inputType: p.inputType,
          options: this.toJsonColumn(p.options),
          unit: p.unit,
          isRequired: p.isRequired,
          sortOrder: p.sortOrder,
          owner: p.owner,
          sourceTechCardId: p.sourceTechCardId,
          sourcePatternItemId: p.sourcePatternItemId ?? null,
          sourceParameterId: p.sourceParameterId,
          value: p.value,
          valueSource: p.valueSource,
          valueUpdatedAt: p.valueUpdatedAt ? new Date(p.valueUpdatedAt) : null,
          valueUpdatedById: p.valueUpdatedById,
        }));
      if (paramRows.length > 0) {
        await tx.orderTechCardParameter.createMany({ data: paramRows });
      }

      // Снимок материалов: восстанавливаем С ИСХОДНЫМИ id (на них без FK
      // ссылается WorkshopNeed.sourceId — после restore ссылка снова
      // живая, и match-ключ восстановления цен работает). Ряды несут
      // sourceTechCardId группы, поэтому resync пойдёт ФАЗА-2
      // recompute-путём: пересчёт количеств без перечитывания шаблона —
      // правки строк варианта сохраняются.
      await tx.orderMaterialRequirement.deleteMany({ where: { orderId } });
      const matRows = snap.materialRequirements.map((r) => ({
        id: r.id,
        orderId,
        orderVariantId:
          r.variantOrdinal == null
            ? null
            : (variantIdByOrdinal.get(r.variantOrdinal) ?? null),
        variantColor: r.variantColor,
        // Этап 5: FK на строки техкарт снят — историческая трассировка
        // восстанавливается как есть.
        sourceTechCardLineId: r.sourceTechCardLineId ?? null,
        sortOrder: r.sortOrder,
        name: r.name,
        unit: r.unit,
        normUnit: r.normUnit,
        qtyPerUnit: r.qtyPerUnit,
        totalQty: r.totalQty,
        note: r.note,
        materialRole: r.materialRole,
        fabricType: r.fabricType,
        densityGsm: r.densityGsm,
        plannedWidthCm: r.plannedWidthCm,
        colorRule: r.colorRule,
        fixedColorText: r.fixedColorText,
        resolvedColorText: r.resolvedColorText,
        requiresColorSelection: r.requiresColorSelection,
        selectedColorText: r.selectedColorText,
        hardwareSizeText: r.hardwareSizeText,
        hardwareMaterialText: r.hardwareMaterialText,
        materialImageUrl: r.materialImageUrl,
        materialImageOriginalFileName: r.materialImageOriginalFileName,
        subtypeKey: r.subtypeKey,
        characteristics: this.toJsonColumn(r.characteristics),
        parameterBindings: this.toJsonColumn(r.parameterBindings),
        sourceTechCardId: r.sourceTechCardId,
        // Этап 3: трассировка на спецификацию восстанавливается verbatim —
        // FK нет, валидность источника не проверяем (снимок независим).
        sourcePatternItemId: r.sourcePatternItemId ?? null,
        sourcePatternLineId: r.sourcePatternLineId ?? null,
        isManual: r.isManual,
        // Источник нормы переживает переключение варианта: иначе правленая
        // в заказе норма переставала быть главнее номенклатуры.
        qtySource: r.qtySource,
        qtySourceRef: r.qtySourceRef,
      }));
      if (matRows.length > 0) {
        await tx.orderMaterialRequirement.createMany({ data: matRows });
      }

      const flipped = await tx.orderCalculation.updateMany({
        where: { id: target.id, isActive: false },
        data: { isActive: true, snapshot: Prisma.DbNull },
      });
      if (flipped.count !== 1) {
        throw this.conflict(
          ORDER_CALCULATION_ERROR_CODES.CONFLICT,
          'Варианты просчёта изменяются параллельно — обновите страницу и повторите.',
        );
      }

      await this.audit.log(
        {
          event: 'ORDER_CALCULATION_ACTIVATED',
          entityType: 'ORDER',
          entityId: orderId,
          payload: {
            calculationId: target.id,
            ordinal: target.ordinal,
            title: target.title,
          },
          employeeId: actorEmployeeId ?? null,
        },
        tx,
      );
    });

    // --- Фаза C: производные существующим путём ----------------------------
    // Потребности НЕ пересчитываем: строки живут per вариант (фаза E).
    await this.orders.resyncColorwayDerived(orderId, actorEmployeeId, {
      skipWorkshopNeedsRecalc: true,
    });

    // --- Фаза D: оверлей route-оверрайдов ПОСЛЕ resync ---------------------
    await this.overlayRouteOverrides(orderId, snap, actorEmployeeId);

    // --- Фаза E: потребности варианта --------------------------------------
    // Итерация 3 «стадия per вариант»: активация НИЧЕГО не считает —
    // вариант-черновик (sentToCalculationAt = null) остаётся черновиком,
    // его расчёт запускается только явной кнопкой («Перевести в расчёт»/
    // «Рассчитать вариант» → OrdersService.startCalculation). Здесь
    // только ре-линк уже существующих строк варианта к пересозданным
    // расцветкам (orderVariantId ушёл в SetNull при replace расцветок).
    const needRows = await this.prisma.workshopNeed.count({
      where: { orderId, orderCalculationId: target.id },
    });
    if (needRows > 0) {
      await this.relinkNeedVariants(orderId, target.id);
    }

    return this.listForOrder(orderId);
  }

  async rename(
    orderId: string,
    calcId: string,
    dto: RenameOrderCalculationDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderCalculationsDto> {
    await this.getOrderOrThrow(orderId);
    const target = await this.prisma.orderCalculation.findFirst({
      where: { id: calcId, orderId },
      select: { id: true },
    });
    if (!target) throw this.notFoundCalc();

    await this.prisma.orderCalculation.update({
      where: { id: calcId },
      data: { title: dto.title },
    });
    await this.audit.log({
      event: 'ORDER_CALCULATION_RENAMED',
      entityType: 'ORDER',
      entityId: orderId,
      payload: { calculationId: calcId, title: dto.title },
      employeeId: actorEmployeeId ?? null,
    });
    return this.listForOrder(orderId);
  }

  async remove(
    orderId: string,
    calcId: string,
    actorEmployeeId?: string | null,
  ): Promise<OrderCalculationsDto> {
    const order = await this.getOrderOrThrow(orderId);
    this.assertEditableStatus(order.status);

    const target = await this.prisma.orderCalculation.findFirst({
      where: { id: calcId, orderId },
      select: { id: true, isActive: true, ordinal: true, title: true },
    });
    if (!target) throw this.notFoundCalc();
    if (target.isActive) {
      throw this.conflict(
        ORDER_CALCULATION_ERROR_CODES.ACTIVE_DELETE_FORBIDDEN,
        'Нельзя удалить активный вариант — сначала переключитесь на другой.',
      );
    }
    const count = await this.prisma.orderCalculation.count({
      where: { orderId },
    });
    if (count <= 1) {
      throw this.conflict(
        ORDER_CALCULATION_ERROR_CODES.LAST_DELETE_FORBIDDEN,
        'Нельзя удалить последний вариант просчёта заказа.',
      );
    }

    // Строки потребности удаляемого варианта нельзя оставлять сиротами:
    // FK объявлен `onDelete: SetNull`, а пустой `orderCalculationId`
    // канонический скоуп читает как «строка вне контура вариантов» и
    // показывает её ВСЕМ читателям заказа. Материалы удалённого варианта
    // складывались бы с активным — сравнение вариантов превращалось в их
    // сложение.
    //
    // Складской остаток защищаем той же логикой, что и пересчёт
    // (`WorkshopNeedsService.calculateForOrder`): `StockBalance` и
    // `StockMovement` каскадятся от строки, и удаление снесло бы
    // физический остаток вместе с журналом движений. Есть движения —
    // отказываем адресной 409, а не портим склад.
    const needsWithStock = await this.prisma.workshopNeed.count({
      where: { orderId, orderCalculationId: calcId, stockMovements: { some: {} } },
    });
    if (needsWithStock > 0) {
      throw this.conflict(
        ORDER_CALCULATION_ERROR_CODES.CONFLICT,
        'Нельзя удалить вариант: по его материалам уже есть складские ' +
          'движения. Сначала отмените приход или расход по этим строкам.',
      );
    }

    const removedNeeds = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.workshopNeed.deleteMany({
        where: { orderId, orderCalculationId: calcId },
      });
      // Смета удаляемого варианта — тот же случай, что и потребности:
      // `OrderCostEstimate.orderCalculationId` уходит в SetNull, а
      // пустое поле канонический скоуп читает как «смета вне контура
      // вариантов» и подставил бы её деньги активному варианту.
      // Документ не сносим (история расчётов), а честно отзываем.
      await tx.orderCostEstimate.updateMany({
        where: { orderId, orderCalculationId: calcId, status: 'COMPLETED' },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedById: actorEmployeeId ?? null,
          comment: `Вариант просчёта «${target.title}» удалён`,
        },
      });
      await tx.orderCalculation.delete({ where: { id: calcId } });
      return count;
    });

    await this.audit.log({
      event: 'ORDER_CALCULATION_DELETED',
      entityType: 'ORDER',
      entityId: orderId,
      payload: {
        calculationId: calcId,
        ordinal: target.ordinal,
        title: target.title,
        removedNeeds,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.listForOrder(orderId);
  }

  // -------------------------------------------------------------------------
  // capture / restore helpers
  // -------------------------------------------------------------------------

  /**
   * Снимок входов ТЕКУЩЕГО (живого) состояния заказа. Вызывается внутри
   * транзакции create/activate — читает через tx для консистентности.
   */
  private async captureSnapshot(
    db: Prisma.TransactionClient,
    orderId: string,
  ): Promise<OrderCalculationSnapshotV1> {
    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        routeTemplateId: true,
        color: true,
        customerUnitPrice: true,
        customerCurrency: true,
        materialsAndHardwareCostPolicy: true,
        patternDevelopmentCostRub: true,
        patternDevelopmentCostInCostPrice: true,
        variants: {
          orderBy: { ordinal: 'asc' },
          select: {
            id: true,
            ordinal: true,
            color: true,
            sizes: { select: { sizeId: true, qtyPlan: true } },
          },
        },
        routeSteps: {
          select: {
            operationId: true,
            rateOverride: true,
            timeNormSecOverride: true,
            pricingModeOverride: true,
            sizeOverrides: {
              select: { sizeId: true, rate: true, seconds: true },
            },
          },
        },
        techCardParameters: {
          select: {
            orderVariantId: true,
            key: true,
            label: true,
            inputType: true,
            options: true,
            unit: true,
            isRequired: true,
            sortOrder: true,
            owner: true,
            sourceTechCardId: true,
            sourcePatternItemId: true,
            sourceParameterId: true,
            value: true,
            valueSource: true,
            valueUpdatedAt: true,
            valueUpdatedById: true,
          },
        },
        materialRequirements: {
          select: {
            id: true,
            orderVariantId: true,
            variantColor: true,
            sourceTechCardLineId: true,
            sortOrder: true,
            name: true,
            unit: true,
            normUnit: true,
            qtyPerUnit: true,
            totalQty: true,
            note: true,
            materialRole: true,
            fabricType: true,
            densityGsm: true,
            plannedWidthCm: true,
            colorRule: true,
            fixedColorText: true,
            resolvedColorText: true,
            requiresColorSelection: true,
            selectedColorText: true,
            hardwareSizeText: true,
            hardwareMaterialText: true,
            materialImageUrl: true,
            materialImageOriginalFileName: true,
            subtypeKey: true,
            characteristics: true,
            parameterBindings: true,
            sourceTechCardId: true,
            sourcePatternItemId: true,
            sourcePatternLineId: true,
            isManual: true,
            qtySource: true,
            qtySourceRef: true,
          },
        },
      },
    });

    const ordinalByVariantId = new Map(
      order.variants.map((v) => [v.id, v.ordinal] as const),
    );
    const toOrdinal = (variantId: string | null): number | null =>
      variantId == null ? null : (ordinalByVariantId.get(variantId) ?? null);

    // Итерация 2: строки живут per вариант — в снимок попадают только
    // ценовые поля строк ДЕАКТИВИРУЕМОГО (ещё активного) варианта.
    // Используется лишь как legacy-фолбэк при первом расчёте варианта.
    const needs = await db.workshopNeed.findMany({
      where: {
        orderId,
        isManual: false,
        AND: [TIRAGE_NEED_WHERE],
      },
      select: {
        orderVariantId: true,
        sourceType: true,
        sourceId: true,
        materialRole: true,
        sourceName: true,
        unit: true,
        purchaseQty: true,
        packSize: true,
        quotedPrice: true,
        quotedCurrency: true,
        supplierNameText: true,
        purchaseItemNameText: true,
        selectedSupplierId: true,
        selectedSupplierCatalogItemId: true,
        comment: true,
        expectedDeliveryDate: true,
      },
    });

    const dec = (v: Prisma.Decimal | null): string | null =>
      v == null ? null : v.toString();

    return {
      version: 1,
      order: {
        routeTemplateId: order.routeTemplateId,
        // Этап 5 «техкарты → номенклатура»: поле остаётся в снимке ради
        // старых снапшотов, новые пишут null.
        techCardId: null,
        color: order.color,
        customerUnitPrice: dec(order.customerUnitPrice),
        customerCurrency: order.customerCurrency,
        materialsAndHardwareCostPolicy: order.materialsAndHardwareCostPolicy,
        patternDevelopmentCostRub: dec(order.patternDevelopmentCostRub),
        patternDevelopmentCostInCostPrice:
          order.patternDevelopmentCostInCostPrice,
      },
      variants: order.variants.map((v) => ({
        ordinal: v.ordinal,
        color: v.color,
        techCardId: null,
        sizes: v.sizes.map((s) => ({ sizeId: s.sizeId, qtyPlan: s.qtyPlan })),
      })),
      // Только шаги, где есть хоть один оверрайд — restore пишет
      // остальным явные null.
      routeOverrides: order.routeSteps
        .filter(
          (s) =>
            s.rateOverride != null ||
            s.timeNormSecOverride != null ||
            s.pricingModeOverride != null ||
            s.sizeOverrides.length > 0,
        )
        .map((s) => ({
          operationId: s.operationId,
          rateOverride: dec(s.rateOverride),
          timeNormSecOverride: s.timeNormSecOverride,
          pricingModeOverride: s.pricingModeOverride,
          sizeOverrides: s.sizeOverrides.map((so) => ({
            sizeId: so.sizeId,
            rate: dec(so.rate),
            seconds: so.seconds,
          })),
        })),
      techCardParameters: order.techCardParameters
        .filter(
          (p) =>
            p.orderVariantId == null ||
            ordinalByVariantId.has(p.orderVariantId),
        )
        .map((p) => ({
          variantOrdinal: toOrdinal(p.orderVariantId),
          key: p.key,
          label: p.label,
          inputType: p.inputType,
          options: p.options,
          unit: p.unit,
          isRequired: p.isRequired,
          sortOrder: p.sortOrder,
          owner: p.owner,
          sourceTechCardId: p.sourceTechCardId,
          sourcePatternItemId: p.sourcePatternItemId,
          sourceParameterId: p.sourceParameterId,
          value: p.value,
          valueSource: p.valueSource,
          valueUpdatedAt: p.valueUpdatedAt?.toISOString() ?? null,
          valueUpdatedById: p.valueUpdatedById,
        })),
      materialRequirements: order.materialRequirements.map((r) => ({
        id: r.id,
        variantOrdinal: toOrdinal(r.orderVariantId),
        variantColor: r.variantColor,
        sourceTechCardLineId: r.sourceTechCardLineId,
        sortOrder: r.sortOrder,
        name: r.name,
        unit: r.unit,
        normUnit: r.normUnit,
        qtyPerUnit: r.qtyPerUnit.toString(),
        totalQty: r.totalQty.toString(),
        note: r.note,
        materialRole: r.materialRole,
        fabricType: r.fabricType,
        densityGsm: r.densityGsm,
        plannedWidthCm: r.plannedWidthCm,
        colorRule: r.colorRule,
        fixedColorText: r.fixedColorText,
        resolvedColorText: r.resolvedColorText,
        requiresColorSelection: r.requiresColorSelection,
        selectedColorText: r.selectedColorText,
        hardwareSizeText: r.hardwareSizeText,
        hardwareMaterialText: r.hardwareMaterialText,
        materialImageUrl: r.materialImageUrl,
        materialImageOriginalFileName: r.materialImageOriginalFileName,
        subtypeKey: r.subtypeKey,
        characteristics: r.characteristics,
        parameterBindings: r.parameterBindings,
        sourceTechCardId: r.sourceTechCardId,
        // Этап 3 «техкарты → номенклатура»: трассировка на спецификацию —
        // без неё активация варианта потеряла бы источник, и ФАЗА-2
        // перематериализовала бы снимок.
        sourcePatternItemId: r.sourcePatternItemId,
        sourcePatternLineId: r.sourcePatternLineId,
        isManual: r.isManual,
        // Источник нормы едет в снимок: `qtySource='ORDER'` = «норму ввели
        // руками, она главнее номенклатуры». Потеряв его, активация другого
        // варианта считала бы потребность по номенклатурной норме.
        qtySource: r.qtySource,
        qtySourceRef: r.qtySourceRef,
      })),
      workshopNeedValues: needs
        .filter(
          (n) =>
            n.purchaseQty != null ||
            n.packSize != null ||
            n.quotedPrice != null ||
            n.quotedCurrency != null ||
            n.supplierNameText != null ||
            n.purchaseItemNameText != null ||
            n.selectedSupplierId != null ||
            n.selectedSupplierCatalogItemId != null ||
            n.comment != null ||
            n.expectedDeliveryDate != null,
        )
        .map((n) => ({
          variantOrdinal: toOrdinal(n.orderVariantId),
          sourceType: n.sourceType,
          sourceId: n.sourceId,
          materialRole: n.materialRole,
          sourceName: n.sourceName,
          unit: n.unit,
          purchaseQty: dec(n.purchaseQty),
          packSize: dec(n.packSize),
          quotedPrice: dec(n.quotedPrice),
          quotedCurrency: n.quotedCurrency,
          supplierNameText: n.supplierNameText,
          purchaseItemNameText: n.purchaseItemNameText,
          selectedSupplierId: n.selectedSupplierId,
          selectedSupplierCatalogItemId: n.selectedSupplierCatalogItemId,
          comment: n.comment,
          expectedDeliveryDate: n.expectedDeliveryDate?.toISOString() ?? null,
        })),
    };
  }

  /**
   * Справочники могли измениться, пока вариант лежал снимком (строки
   * шаблонов техкарт физически пересоздаются при сейве справочника,
   * поставщика могли удалить). Несуществующие ссылки при restore
   * зануляются — зеркало SetNull-семантики живых FK.
   */
  private async validateSnapshotRefs(
    snap: OrderCalculationSnapshotV1,
  ): Promise<SnapshotRefs> {
    const sizeIds = [
      ...new Set([
        ...snap.variants.flatMap((v) => v.sizes.map((s) => s.sizeId)),
        ...snap.routeOverrides.flatMap((o) =>
          o.sizeOverrides.map((so) => so.sizeId),
        ),
      ]),
    ];
    const supplierIds = [
      ...new Set(
        snap.workshopNeedValues
          .map((n) => n.selectedSupplierId)
          .filter((id): id is string => id != null),
      ),
    ];
    const catalogItemIds = [
      ...new Set(
        snap.workshopNeedValues
          .map((n) => n.selectedSupplierCatalogItemId)
          .filter((id): id is string => id != null),
      ),
    ];

    const [sizes, suppliers, catalogItems, routeTemplate] =
      await Promise.all([
        sizeIds.length
          ? this.prisma.size.findMany({
              where: { id: { in: sizeIds } },
              select: { id: true },
            })
          : Promise.resolve([]),
        supplierIds.length
          ? this.prisma.supplier.findMany({
              where: { id: { in: supplierIds } },
              select: { id: true },
            })
          : Promise.resolve([]),
        catalogItemIds.length
          ? this.prisma.supplierCatalogItem.findMany({
              where: { id: { in: catalogItemIds } },
              select: { id: true },
            })
          : Promise.resolve([]),
        snap.order.routeTemplateId
          ? this.prisma.routeTemplate.findUnique({
              where: { id: snap.order.routeTemplateId },
              select: { id: true },
            })
          : Promise.resolve(null),
      ]);

    return {
      validSizeIds: new Set(sizes.map((s) => s.id)),
      validSupplierIds: new Set(suppliers.map((s) => s.id)),
      validCatalogItemIds: new Set(catalogItems.map((c) => c.id)),
      routeTemplateId: routeTemplate?.id ?? null,
    };
  }

  /**
   * Фаза D: оверлей route-оверрайдов после resync. Пишем значения ВСЕМ
   * шагам свежего снимка маршрута: из снимка варианта по operationId,
   * отсутствующим — явные null (иначе carry-механика
   * `syncOrderRouteStepsSnapshot` протащит оверрайды предыдущего
   * варианта). Побочный кейс: операция, добавленная в шаблон после
   * снятия снимка, теряет сид расценки из шаблона — детерминированно и
   * самолечится правкой в UI.
   */
  private async overlayRouteOverrides(
    orderId: string,
    snap: OrderCalculationSnapshotV1,
    actorEmployeeId?: string | null,
  ): Promise<void> {
    const freshSteps = await this.prisma.orderRouteStep.findMany({
      where: { orderId },
      select: { id: true, operationId: true },
    });
    if (freshSteps.length === 0) return;

    const planSizeIds = new Set(
      (
        await this.prisma.orderItem.findMany({
          where: { orderId },
          select: { sizeId: true },
        })
      ).map((i) => i.sizeId),
    );
    const byOperation = new Map(
      snap.routeOverrides.map((o) => [o.operationId, o] as const),
    );

    const dto: UpdateOrderRouteOverridesDto = {
      steps: freshSteps.map((s) => {
        const o = byOperation.get(s.operationId);
        return {
          stepId: s.id,
          pricingModeOverride: (o?.pricingModeOverride ??
            null) as PricingMode | null,
          rateOverride: o?.rateOverride == null ? null : Number(o.rateOverride),
          timeNormSecOverride: o?.timeNormSecOverride ?? null,
          sizeOverrides: (o?.sizeOverrides ?? [])
            .filter((so) => planSizeIds.has(so.sizeId))
            .map((so) => ({
              sizeId: so.sizeId,
              rate: so.rate == null ? null : Number(so.rate),
              seconds: so.seconds,
            })),
        };
      }),
    };
    await this.orders.updateRouteOverrides(orderId, dto, actorEmployeeId);
  }

  /**
   * Фаза E (строки варианта уже есть): ре-линк `orderVariantId` строк
   * потребности к пересозданным расцветкам. Расцветки при restore
   * пересоздаются с новыми id, и `WorkshopNeed.orderVariantId` строк
   * этого варианта ушёл в SetNull — восстанавливаем привязку по
   * `variantColor` (snapshot цвета на строке). Строки с цветом, которого
   * больше нет среди расцветок, остаются order-level (variantColor
   * продолжает работать как presentation-подпись).
   */
  private async relinkNeedVariants(
    orderId: string,
    calculationId: string,
  ): Promise<void> {
    const variants = await this.prisma.orderVariant.findMany({
      where: { orderId },
      orderBy: { ordinal: 'asc' },
      select: { id: true, color: true },
    });
    // При дублях цвета побеждает первая расцветка (ordinal asc) — тот же
    // принцип «первая — первичная», что у моста techCardId.
    const idByColor = new Map<string, string>();
    for (const v of variants) {
      if (!idByColor.has(v.color)) idByColor.set(v.color, v.id);
    }
    for (const [color, variantId] of idByColor) {
      await this.prisma.workshopNeed.updateMany({
        where: {
          orderId,
          orderCalculationId: calculationId,
          orderVariantId: null,
          variantColor: color,
        },
        data: { orderVariantId: variantId },
      });
    }
  }

  /**
   * Паспорта заказа, привязанные к расцветке, вместе с её цветом.
   * Нужны переключению варианта: restore пересоздаёт `OrderVariant`, и
   * привязку паспорта надо снять «до» и вернуть «после» (по цвету).
   *
   * На DRAFT/CALCULATION/CALCULATION_DONE список пуст — паспорта
   * появляются на раскрое и на сигнальном образце.
   */
  private async passportVariantLinks(
    orderId: string,
  ): Promise<Array<{ passportId: string; color: string }>> {
    const rows = await this.prisma.passport.findMany({
      where: { orderId, orderVariantId: { not: null } },
      select: { id: true, orderVariant: { select: { color: true } } },
    });
    return rows
      .filter((r) => r.orderVariant != null)
      .map((r) => ({ passportId: r.id, color: r.orderVariant!.color }));
  }

  /**
   * Snapshot-поля себестоимости заказа для ЦЕЛЕВОГО варианта плюс
   * статус расчёта.
   *
   * Расчёт завершают по каждому варианту (`OrderCostEstimate`
   * принадлежит варианту), поэтому при переключении вкладки «смета
   * заказа» обязана переехать на смету цели, а `Order.status` —
   * следовать за ней: есть завершённая смета → `CALCULATION_DONE`, нет
   * → `CALCULATION`. Так весь остальной бэк и UI, завязанные на статус
   * («Завершить расчёт» у закупщика, окно правки, запуск в
   * производство), продолжают работать без единой правки.
   *
   * Статус двигаем ТОЛЬКО между `CALCULATION` и `CALCULATION_DONE`:
   * `DRAFT` (расчёт ещё не запускали) и `SAMPLE_PRODUCTION` (идёт
   * образец) — самостоятельные стадии документа, их переключение
   * вкладки не отменяет.
   */
  private async estimateFieldsForCalculation(
    tx: Prisma.TransactionClient,
    orderId: string,
    calculationId: string,
    currentStatus: OrderStatus,
  ): Promise<Prisma.OrderUncheckedUpdateInput> {
    const estimate = await tx.orderCostEstimate.findFirst({
      where: { orderId, orderCalculationId: calculationId, status: 'COMPLETED' },
      orderBy: { version: 'desc' },
      select: { totalCostRub: true, completedAt: true, version: true },
    });

    const fields: Prisma.OrderUncheckedUpdateInput = {
      costEstimateTotalRub: estimate?.totalCostRub ?? null,
      costEstimateCompletedAt: estimate?.completedAt ?? null,
      costEstimateVersion: estimate?.version ?? null,
      // Отметка «себестоимость устарела» относилась к прежней смете.
      costEstimateStaleAt: null,
      costEstimateStaleReason: null,
    };
    if (
      currentStatus === OrderStatus.CALCULATION ||
      currentStatus === OrderStatus.CALCULATION_DONE
    ) {
      fields.status = estimate
        ? OrderStatus.CALCULATION_DONE
        : OrderStatus.CALCULATION;
    }
    return fields;
  }

  // -------------------------------------------------------------------------
  // small helpers
  // -------------------------------------------------------------------------

  /** У заказа всегда ≥1 калькуляция: страховка для заказов, созданных
   *  до фичи/мимо `OrdersService.create` (бэкфилл миграции покрывает
   *  существующие, это — третий рубеж). */
  private async ensureBaseline(
    orderId: string,
    costTotalRub: Prisma.Decimal | null,
  ): Promise<void> {
    const count = await this.prisma.orderCalculation.count({
      where: { orderId },
    });
    if (count > 0) return;
    await this.prisma.orderCalculation.create({
      data: {
        orderId,
        ordinal: 0,
        title: 'Вариант 1',
        isActive: true,
        costTotalRub,
      },
    });
  }

  private async getOrderOrThrow(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, costEstimateTotalRub: true },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    return order;
  }

  /**
   * Вариант считается ВЫБРАННЫМ в момент запуска в производство — до
   * этого вкладки живые. Завершённый расчёт вариант не фиксирует:
   * расчёт завершают по каждому варианту, чтобы сравнить готовые сметы
   * (`OrderCostEstimate.orderCalculationId`), а `CALCULATION_DONE`
   * следует за активной вкладкой (см. `syncOrderToCalculationEstimate`).
   */
  private isEditableStatus(status: OrderStatus): boolean {
    return (
      status === OrderStatus.DRAFT ||
      status === OrderStatus.CALCULATION ||
      status === OrderStatus.CALCULATION_DONE ||
      status === OrderStatus.SAMPLE_PRODUCTION
    );
  }

  private assertEditableStatus(status: OrderStatus): void {
    if (this.isEditableStatus(status)) return;
    throw this.conflict(
      ORDER_CALCULATION_ERROR_CODES.LOCKED,
      'Заказ уже запущен в производство — вариант просчёта выбран. Остальные варианты остаются историей просчёта, их нельзя переключать, создавать и удалять.',
    );
  }

  private conflict(code: string, message: string): ConflictException {
    return new ConflictException({ statusCode: 409, code, message });
  }

  private notFoundCalc(): NotFoundException {
    return new NotFoundException({
      statusCode: 404,
      code: ORDER_CALCULATION_ERROR_CODES.NOT_FOUND,
      message: 'Вариант просчёта не найден',
    });
  }

  private toJsonColumn(
    value: unknown,
  ): Prisma.InputJsonValue | typeof Prisma.DbNull {
    return value == null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
  }

  /** Схлопывает дубли размеров и выкидывает нулевые строки (семантика
   *  `OrdersService.writeOrderVariants`). */
  private normalizeSizes(
    rows: Array<{ sizeId: string; qtyPlan: number }>,
  ): Array<{ sizeId: string; qtyPlan: number }> {
    const bySize = new Map<string, number>();
    for (const r of rows) {
      bySize.set(r.sizeId, (bySize.get(r.sizeId) ?? 0) + r.qtyPlan);
    }
    return [...bySize.entries()]
      .filter(([, qty]) => qty > 0)
      .map(([sizeId, qtyPlan]) => ({ sizeId, qtyPlan }));
  }
}
