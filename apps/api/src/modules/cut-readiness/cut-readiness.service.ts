import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CUT_BLOCKING_MATERIAL_ROLES,
  isCutBlockingMaterialRole,
  type CutMaterialArrivalOverrideRefDto,
  type CutMaterialReadinessCellDto,
  type CutMaterialReadinessDto,
  type CutReadinessCheckDto,
  type CutReadinessCheckStatus,
  type CutReadinessDto,
  type CutReadinessStatus,
} from '@sewing/shared/cut-readiness';
import { getTechCardMaterialRoleLabel } from '@sewing/shared/tech-cards';
import {
  ORDER_APPLICATION_TYPE_LABELS,
  isOrderApplicationDataFilled,
  type OrderApplicationStage,
  type OrderApplicationType,
} from '@sewing/shared/order-applications';

import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Сервис «Готовность к крою» (Этап 8А, MVP).
 *
 * Read-only проверка: сервис ничего не пишет в БД, не меняет
 * `Order.status`, `WorkshopNeed.status`, `PurchaseReceipt.status`,
 * `CellContent`, паспорта и т.п. (см. `docs/recon-soft-integration.md
 * §«Этап 8А»`). Чтение `OrderMaterialArrivalOverride` тоже остаётся
 * read-only — overrides создаёт отдельный модуль (см.
 * `apps/api/src/modules/order-material-arrivals/*`).
 *
 * Высокоуровневый алгоритм `getForOrder(orderId)`:
 *   1. Загрузить заказ с relevant include-ами (см.
 *      `CUT_READINESS_ORDER_INCLUDE`).
 *   2. Проверить базовый setup заказа (`status` / размеры /
 *      `patternItemId` / `techCardId` / `routeTemplateId` / цвет).
 *   3. Проверить лекало: для каждого размера с `qtyPlan > 0` —
 *      активный DXF (`PatternSizeFile.status = ACTIVE`); для
 *      критичных ролей — наличие `PatternMaterialArea`.
 *   4. По каждой `WorkshopNeed` посчитать
 *      `targetQty / receivedQty / placedQty` по POSTED строкам
 *      приёмки + `manualArrivedQty` по ACTIVE-overrides и
 *      определить статус строки. Если `placedQty + manualArrivedQty
 *      >= targetQty`, строка считается готовой и помечается
 *      `manuallyUnblocked = true`, если override фактически закрыл
 *      разрыв.
 *   5. Сформировать сводку: `blockers/warnings` плоскими списками
 *      + `sections.materials` для UI-таблицы.
 */
@Injectable()
export class CutReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async getForOrder(orderId: string): Promise<CutReadinessDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: CUT_READINESS_ORDER_INCLUDE,
    });
    if (!order) {
      // Используем тот же inline-формат, что и `OrdersService` /
      // `WorkshopNeedsService` — без отдельной BusinessException-обёртки,
      // чтобы не плодить новые типы под одну точку.
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    const workshopNeeds = await this.prisma.workshopNeed.findMany({
      where: { orderId },
      include: WORKSHOP_NEED_INCLUDE,
      orderBy: [{ materialRole: 'asc' }, { createdAt: 'asc' }],
    });

    // Этап «Ручная отметка поступления материала»: ACTIVE-overrides
    // по заказу. Группируем по `workshopNeedId`, чтобы передать
    // в `buildMaterialDto` готовый список (без дополнительного
    // JOIN-а в include WorkshopNeed — это упрощает Prisma-include и
    // не плодит N+1 запросов: один список на заказ).
    const activeOverrides =
      await this.prisma.orderMaterialArrivalOverride.findMany({
        where: { orderId, status: 'ACTIVE' },
        include: {
          createdBy: { select: { id: true, fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    const overridesByNeedId = new Map<string, typeof activeOverrides>();
    for (const ov of activeOverrides) {
      if (!ov.workshopNeedId) continue;
      const list = overridesByNeedId.get(ov.workshopNeedId) ?? [];
      list.push(ov);
      overridesByNeedId.set(ov.workshopNeedId, list);
    }

    // -----------------------------------------------------------------------
    // A. Order setup checks
    // -----------------------------------------------------------------------
    const orderSetup: CutReadinessCheckDto[] = [];

    if (order.status === 'CANCELLED') {
      orderSetup.push({
        key: 'order.status.cancelled',
        status: 'BLOCKER',
        title: 'Заказ отменён',
        message:
          'Заказ в статусе CANCELLED — крой по нему не нужен.',
        entityType: 'ORDER',
        entityId: order.id,
      });
    } else if (order.status === 'DONE') {
      orderSetup.push({
        key: 'order.status.done',
        status: 'WARNING',
        title: 'Заказ закрыт',
        message:
          'Заказ уже в статусе DONE — крой обычно не требуется.',
        entityType: 'ORDER',
        entityId: order.id,
      });
    } else {
      orderSetup.push({
        key: 'order.status.ok',
        status: 'OK',
        title: 'Статус заказа',
        message: `Текущий статус: ${order.status}.`,
        entityType: 'ORDER',
        entityId: order.id,
      });
    }

    const itemsWithQty = order.items.filter((it) => it.qtyPlan > 0);
    if (itemsWithQty.length === 0) {
      orderSetup.push({
        key: 'order.items.required',
        status: 'BLOCKER',
        title: 'Размерная матрица пуста',
        message:
          'В заказе нет ни одного размера с количеством > 0.',
      });
    } else {
      orderSetup.push({
        key: 'order.items.ok',
        status: 'OK',
        title: 'Размерная матрица',
        message: `Размеров с qty > 0: ${itemsWithQty.length}.`,
      });
    }

    if (!order.patternItemId) {
      orderSetup.push({
        key: 'order.patternItemId.required',
        status: 'BLOCKER',
        title: 'Лекало не выбрано',
        message:
          'Без лекала раскройщик не сможет получить DXF-файлы по размерам.',
      });
    } else {
      orderSetup.push({
        key: 'order.patternItemId.ok',
        status: 'OK',
        title: 'Лекало выбрано',
        entityType: 'PATTERN_ITEM',
        entityId: order.patternItemId,
      });
    }

    if (!order.techCardId) {
      orderSetup.push({
        key: 'order.techCardId.required',
        status: 'BLOCKER',
        title: 'Техкарта не выбрана',
        message:
          'Без техкарты не определены материалы и нормы расхода.',
      });
    } else {
      orderSetup.push({
        key: 'order.techCardId.ok',
        status: 'OK',
        title: 'Техкарта выбрана',
        entityType: 'TECH_CARD',
        entityId: order.techCardId,
      });
    }

    if (!order.routeTemplateId && order.routeSteps.length === 0) {
      orderSetup.push({
        key: 'order.routeTemplateId.required',
        status: 'BLOCKER',
        title: 'Маршрут не выбран',
        message:
          'У заказа не зафиксирован шаблон маршрута и нет snapshot-шагов.',
      });
    } else {
      orderSetup.push({
        key: 'order.routeTemplateId.ok',
        status: 'OK',
        title: 'Маршрут зафиксирован',
        entityType: 'ROUTE_TEMPLATE',
        entityId: order.routeTemplateId ?? null,
      });
    }

    const colorText = (order.color ?? '').trim();
    if (colorText === '') {
      orderSetup.push({
        key: 'order.color.missing',
        status: 'WARNING',
        title: 'Цвет заказа не указан',
        message:
          'Возможны заказы без цвета, но обычно его указывают для подбора материала.',
      });
    } else {
      orderSetup.push({
        key: 'order.color.ok',
        status: 'OK',
        title: 'Цвет заказа',
        message: colorText,
      });
    }

    // -----------------------------------------------------------------------
    // B. Pattern checks
    // -----------------------------------------------------------------------
    const patternChecks: CutReadinessCheckDto[] = [];

    if (order.patternItem) {
      // 1. Файл лекала (PDF/PLT/DXF/PLO) по каждому размеру с qtyPlan > 0.
      //    Размер-заглушка (ACTIVE, но fileUrl = null) НЕ считается
      //    готовым — файл могли ещё не догрузить.
      const activeFilesBySize = new Map<string, number>();
      for (const f of order.patternItem.sizeFiles) {
        if (f.status !== 'ACTIVE') continue;
        if (!f.fileUrl) continue;
        activeFilesBySize.set(
          f.sizeId,
          (activeFilesBySize.get(f.sizeId) ?? 0) + 1,
        );
      }

      const missingFileSizes: string[] = [];
      for (const item of itemsWithQty) {
        if (!activeFilesBySize.has(item.sizeId)) {
          missingFileSizes.push(item.size.code);
        }
      }
      if (missingFileSizes.length > 0) {
        patternChecks.push({
          key: 'pattern.sizeFiles.missing',
          status: 'BLOCKER',
          title: 'Нет файла лекала по размерам',
          message: `Не загружен файл лекала (PDF/PLT/DXF/PLO) для размеров: ${missingFileSizes.join(', ')}.`,
          entityType: 'PATTERN_ITEM',
          entityId: order.patternItem.id,
        });
      } else if (itemsWithQty.length > 0) {
        patternChecks.push({
          key: 'pattern.sizeFiles.ok',
          status: 'OK',
          title: 'Файлы лекала по размерам загружены',
          message: `Активных размеров: ${activeFilesBySize.size}.`,
          entityType: 'PATTERN_ITEM',
          entityId: order.patternItem.id,
        });
      }

      // 2. PatternMaterialArea для критичных ролей, реально
      //    встречающихся в техкарте/snapshot заказа.
      const techCardLineRoles = new Set<string>();
      for (const l of order.techCard?.materialLines ?? []) {
        if (l.materialRole) techCardLineRoles.add(l.materialRole);
      }
      for (const r of order.materialRequirements) {
        if (r.materialRole) techCardLineRoles.add(r.materialRole);
      }

      const areaByRoleAndSize = new Map<string, Set<string>>();
      for (const a of order.patternItem.materialAreas) {
        const key = a.materialRole;
        const set = areaByRoleAndSize.get(key) ?? new Set<string>();
        set.add(a.sizeId);
        areaByRoleAndSize.set(key, set);
      }

      for (const role of CUT_BLOCKING_MATERIAL_ROLES) {
        if (!techCardLineRoles.has(role)) continue;
        const coveredSizes = areaByRoleAndSize.get(role);
        if (!coveredSizes || coveredSizes.size === 0) {
          // На MVP — WARNING, не BLOCKER: потребность могла быть
          // посчитана QTY_PER_UNIT-ом и крой как процесс возможен.
          patternChecks.push({
            key: `pattern.materialAreas.${role}.missing`,
            status: 'WARNING',
            title: `Площади лекала по роли ${role} не заданы`,
            message:
              'Расчёт потребности по площади и плотности невозможен — будет использован fallback по норме техкарты.',
            entityType: 'PATTERN_ITEM',
            entityId: order.patternItem.id,
          });
          continue;
        }
        const missingForRole: string[] = [];
        for (const item of itemsWithQty) {
          if (!coveredSizes.has(item.sizeId)) {
            missingForRole.push(item.size.code);
          }
        }
        if (missingForRole.length > 0) {
          patternChecks.push({
            key: `pattern.materialAreas.${role}.partial`,
            status: 'WARNING',
            title: `Не все размеры покрыты площадями для ${role}`,
            message: `Нет площади для размеров: ${missingForRole.join(', ')}.`,
            entityType: 'PATTERN_ITEM',
            entityId: order.patternItem.id,
          });
        } else {
          patternChecks.push({
            key: `pattern.materialAreas.${role}.ok`,
            status: 'OK',
            title: `Площади лекала по роли ${role}`,
            message: `Покрыты ${coveredSizes.size} размер(ов).`,
            entityType: 'PATTERN_ITEM',
            entityId: order.patternItem.id,
          });
        }
      }
    } else {
      // Pattern checks без лекала бесполезны — основной BLOCKER уже
      // зафиксирован в orderSetup выше. Дублировать его здесь не
      // нужно, но дадим явный INFO, чтобы UI показал «секция пуста
      // по объективной причине».
      patternChecks.push({
        key: 'pattern.skipped',
        status: 'INFO',
        title: 'Лекало не выбрано — проверка лекала пропущена',
      });
    }

    // -----------------------------------------------------------------------
    // C. Workshop need / material checks
    // -----------------------------------------------------------------------
    const materials: CutMaterialReadinessDto[] = [];
    const receiptChecks: CutReadinessCheckDto[] = [];

    // C.1. Сначала отметим строки техкарты/snapshot БЕЗ роли —
    // они не участвуют в расчёте готовности, но выводим warning.
    let unrolledTechCardLines = 0;
    for (const l of order.techCard?.materialLines ?? []) {
      if (!l.materialRole) unrolledTechCardLines++;
    }
    for (const r of order.materialRequirements) {
      if (!r.materialRole) unrolledTechCardLines++;
    }
    if (unrolledTechCardLines > 0) {
      receiptChecks.push({
        key: 'materials.techCard.unrolled',
        status: 'WARNING',
        title: 'В техкарте есть строки без роли',
        message: `Найдено строк без materialRole: ${unrolledTechCardLines}. Они не участвуют в проверке готовности к крою.`,
      });
    }

    // C.2. Группа критичных WorkshopNeed-ов: критичная роль и
    //      статус != CANCELLED — основной материал кроя.
    const criticalNeeds = workshopNeeds.filter(
      (n) => isCutBlockingMaterialRole(n.materialRole) && n.status !== 'CANCELLED',
    );
    const cancelledCriticalNeeds = workshopNeeds.filter(
      (n) => isCutBlockingMaterialRole(n.materialRole) && n.status === 'CANCELLED',
    );

    if (criticalNeeds.length === 0) {
      receiptChecks.push({
        key: 'materials.critical.empty',
        status: 'BLOCKER',
        title: 'Нет рассчитанных потребностей по критичным материалам',
        message:
          'Нажмите «Просчитать потребность» в карточке заказа. Без потребностей по MAIN_FABRIC/RIB/LINING нельзя проверить готовность к крою.',
      });
    }

    for (const need of cancelledCriticalNeeds) {
      // Отменённая потребность сама по себе не блокирует — у заказа
      // могут быть нормальные строки по той же роли. Дадим WARNING,
      // чтобы пользователь видел, что роль вообще «была отменена».
      receiptChecks.push({
        key: `need.cancelled.${need.id}`,
        status: 'WARNING',
        title: `Потребность отменена: ${need.description}`,
        message:
          'Эта строка не учитывается в проверке готовности к крою.',
        entityType: 'WORKSHOP_NEED',
        entityId: need.id,
      });
    }

    // C.3. Активные критичные строки.
    for (const need of criticalNeeds) {
      materials.push(
        this.buildMaterialDto(
          need,
          /* critical */ true,
          overridesByNeedId.get(need.id) ?? [],
        ),
      );
    }

    // C.4. Некритичные роли (THREAD/PACKAGING/APPLICATION или
    //      незнакомые роли) — в materials, но со статусом INFO/WARNING.
    const nonCriticalNeeds = workshopNeeds.filter(
      (n) =>
        !isCutBlockingMaterialRole(n.materialRole) && n.status !== 'CANCELLED',
    );
    for (const need of nonCriticalNeeds) {
      materials.push(
        this.buildMaterialDto(
          need,
          /* critical */ false,
          overridesByNeedId.get(need.id) ?? [],
        ),
      );
    }

    // -----------------------------------------------------------------------
    // C.5. Order applications (этап «Нанесение на заказе покупателя»)
    // -----------------------------------------------------------------------
    //
    // Параметры нанесения — атрибут заказа покупателя, а не техкарты.
    // Бизнес-логика готовности к крою:
    //   - `CUT_PARTS` (нанесение на крое): если параметры не заполнены —
    //     добавляем BLOCKER, крой не запускается; если заполнены —
    //     WARNING «после кроя детали нужно отправить на нанесение»
    //     (крой не блокируется, но менеджер должен видеть напоминание).
    //   - `FINISHED_ITEM` (на готовом изделии): только INFO/WARNING
    //     «крой не блокируется, нанесение выполняется после пошива».
    //   - `CANCELLED` строки игнорируем — менеджер их явно отменил.
    //
    // Helper `isOrderApplicationDataFilled` живёт в shared-пакете —
    // тот же критерий мы используем на UI для подсветки строк.
    const applicationChecks: CutReadinessCheckDto[] = [];
    for (const app of order.applications ?? []) {
      if (app.status === 'CANCELLED') continue;
      const stage = app.stage as OrderApplicationStage;
      const type = app.type as OrderApplicationType;
      const typeLabel =
        type in ORDER_APPLICATION_TYPE_LABELS
          ? ORDER_APPLICATION_TYPE_LABELS[type]
          : app.type;

      if (stage === 'CUT_PARTS') {
        const filled = isOrderApplicationDataFilled({
          type,
          placement: app.placement,
          description: app.description,
          widthMm: app.widthMm,
          heightMm: app.heightMm,
        });
        if (!filled) {
          applicationChecks.push({
            key: `application.cut.${app.id}.empty`,
            status: 'BLOCKER',
            title: 'Нанесение на крое не заполнено',
            message: `Заказ требует нанесение «${typeLabel}» на крое, но параметры (место, описание или размер макета) не указаны.`,
            entityType: null,
            entityId: app.id,
          });
        } else {
          applicationChecks.push({
            key: `application.cut.${app.id}.warning`,
            status: 'WARNING',
            title: 'Нанесение на крое',
            message: `«${typeLabel}»: после кроя детали нужно отправить на нанесение.`,
            entityType: null,
            entityId: app.id,
          });
        }
      } else if (stage === 'FINISHED_ITEM') {
        applicationChecks.push({
          key: `application.finished.${app.id}.info`,
          status: 'INFO',
          title: 'Нанесение на готовом изделии',
          message: `«${typeLabel}»: крой не блокируется. Нанесение выполняется после пошива.`,
          entityType: null,
          entityId: app.id,
        });
      }
    }

    // -----------------------------------------------------------------------
    // D. Aggregate counts / status
    // -----------------------------------------------------------------------
    const allChecks: CutReadinessCheckDto[] = [
      ...orderSetup,
      ...patternChecks,
      ...receiptChecks,
      ...applicationChecks,
    ];
    const blockers: CutReadinessCheckDto[] = [];
    const warnings: CutReadinessCheckDto[] = [];

    for (const c of allChecks) {
      if (c.status === 'BLOCKER') blockers.push(c);
      else if (c.status === 'WARNING') warnings.push(c);
    }
    for (const m of materials) {
      // Материальные строки тоже попадают в плоские срезы — UI
      // рендерит их в «Блокерах»/«Предупреждениях» плоским списком.
      if (m.status === 'BLOCKER') {
        blockers.push(this.materialToCheck(m));
      } else if (m.status === 'WARNING') {
        warnings.push(this.materialToCheck(m));
      }
    }

    const blockersCount = blockers.length;
    const warningsCount = warnings.length;
    const ready = blockersCount === 0;
    const status: CutReadinessStatus =
      blockersCount > 0
        ? 'NOT_READY'
        : warningsCount > 0
          ? 'WARNING_ONLY'
          : 'READY';

    return {
      orderId: order.id,
      ready,
      status,
      blockersCount,
      warningsCount,
      checkedAt: new Date().toISOString(),
      sections: {
        orderSetup,
        pattern: patternChecks,
        materials,
        receipts: receiptChecks,
        applications: applicationChecks,
      },
      blockers,
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // INTERNAL: build per-material DTO
  // ---------------------------------------------------------------------------

  private buildMaterialDto(
    need: WorkshopNeedRowWithReceipts,
    critical: boolean,
    overrides: ManualArrivalOverrideRow[],
  ): CutMaterialReadinessDto {
    const role = (need.materialRole ?? '').trim() || 'UNKNOWN';
    const purchaseQty = need.purchaseQty
      ? new Prisma.Decimal(need.purchaseQty)
      : null;
    const calculatedQty = new Prisma.Decimal(need.calculatedQty);
    const targetDecimal = purchaseQty ?? calculatedQty;

    // Σ POSTED receipt lines (всегда отфильтрованы по
    // status = POSTED — даже если документ PR в CANCELLED, строки
    // тоже становятся CANCELLED, см. PurchaseReceiptsService.cancel).
    let receivedQty = new Prisma.Decimal(0);
    let placedQty = new Prisma.Decimal(0);
    const cellAggMap = new Map<
      string,
      {
        cellId: string;
        cellCode: string;
        warehouseName: string | null;
        lineName: string | null;
        qty: Prisma.Decimal;
        unit: string;
      }
    >();

    for (const line of need.receiptLines) {
      if (line.status !== 'POSTED') continue;
      receivedQty = receivedQty.add(line.receivedQty);
      if (line.cellId && line.cell) {
        placedQty = placedQty.add(line.receivedQty);
        const existing = cellAggMap.get(line.cellId);
        if (existing) {
          existing.qty = existing.qty.add(line.receivedQty);
        } else {
          cellAggMap.set(line.cellId, {
            cellId: line.cellId,
            cellCode: line.cell.code,
            warehouseName: line.cell.warehouse?.name ?? null,
            lineName: line.cell.line?.code ?? null,
            qty: line.receivedQty,
            unit: line.unit,
          });
        }
      }
    }

    const cells: CutMaterialReadinessCellDto[] = Array.from(
      cellAggMap.values(),
    )
      .sort((a, b) => a.cellCode.localeCompare(b.cellCode, 'ru'))
      .map((c) => ({
        cellId: c.cellId,
        cellCode: c.cellCode,
        warehouseName: c.warehouseName,
        lineName: c.lineName,
        qty: c.qty.toString(),
        unit: c.unit,
      }));

    // Этап «Ручная отметка поступления материала»:
    // Σ ACTIVE-overrides по этой `WorkshopNeed`. Если у override
    // qty IS NULL — считаем покрытие = `targetDecimal` (создатель
    // override мог не знать точное количество, но сказал «материал
    // есть»). Подробности — в JSDoc `CutMaterialReadinessDto.manualArrivedQty`.
    let manualArrivedQty = new Prisma.Decimal(0);
    const manualArrivalRefs: CutMaterialArrivalOverrideRefDto[] = [];
    for (const ov of overrides) {
      const ovQty = ov.qty
        ? new Prisma.Decimal(ov.qty)
        : targetDecimal.greaterThan(0)
          ? targetDecimal
          : new Prisma.Decimal(0);
      manualArrivedQty = manualArrivedQty.add(ovQty);
      manualArrivalRefs.push({
        id: ov.id,
        qty: ov.qty ? ov.qty.toString() : null,
        unit: ov.unit,
        comment: ov.comment,
        createdById: ov.createdById,
        createdByName: ov.createdBy?.fullName ?? null,
        createdAt: ov.createdAt.toISOString(),
      });
    }
    const effectivePlacedQty = placedQty.add(manualArrivedQty);

    let status: CutReadinessCheckStatus;
    let message: string | null;
    let ready: boolean;
    let manuallyUnblocked = false;

    const targetStr = targetDecimal.toString();
    const receivedStr = receivedQty.toString();
    const placedStr = placedQty.toString();
    const manualStr = manualArrivedQty.toString();

    if (!critical) {
      // Некритичная роль (THREAD/PACKAGING/APPLICATION/неизвестная).
      // Не блокирует крой; статус — INFO/WARNING. Override на
      // некритичной строке тоже допустим — UI его отрендерит, но
      // готовность строки и так всегда `ready = true`.
      if (need.receiptLines.every((l) => l.status !== 'POSTED')) {
        status = 'INFO';
        message =
          'Некритичный материал: ещё не принят, но крой по этой строке не блокируется.';
      } else if (placedQty.lessThan(targetDecimal)) {
        status = 'WARNING';
        message = `Принято ${receivedStr}/${targetStr} ${need.unit}, размещено ${placedStr}. Не блокирует крой.`;
      } else {
        status = 'INFO';
        message = `Принято и размещено ${placedStr}/${targetStr} ${need.unit}.`;
      }
      ready = true;
    } else if (placedQty.greaterThanOrEqualTo(targetDecimal) && targetDecimal.greaterThan(0)) {
      // Реальная приёмка уже закрыла потребность. Override
      // (если есть) только дублирует — не помечаем `manuallyUnblocked`,
      // потому что бизнес-смысл «крой разблокирован вручную»
      // относится только к случаям, когда без override строка
      // была бы блокером.
      status = 'OK';
      message = `Размещено ${placedStr} ${need.unit} (требуется ${targetStr}).`;
      ready = true;
    } else if (targetDecimal.lessThanOrEqualTo(0)) {
      status = 'WARNING';
      message =
        'Целевое количество <= 0: проверьте purchaseQty/calculatedQty.';
      ready = false;
    } else if (
      manualArrivedQty.greaterThan(0) &&
      effectivePlacedQty.greaterThanOrEqualTo(targetDecimal)
    ) {
      // Ручной override закрыл разрыв — крой разблокирован вручную.
      status = 'OK';
      manuallyUnblocked = true;
      ready = true;
      message = `Разблокировано вручную: материал отмечен как поступивший без складской приёмки. Размещено ${placedStr} + ручная отметка ${manualStr} = ${effectivePlacedQty.toString()} ${need.unit} (требуется ${targetStr}).`;
    } else if (
      receivedQty.greaterThanOrEqualTo(targetDecimal) &&
      placedQty.lessThan(targetDecimal)
    ) {
      status = 'BLOCKER';
      message = `Материал принят (${receivedStr} ${need.unit}), но не размещён в ячейке (${placedStr} ${need.unit}).`;
      ready = false;
    } else if (receivedQty.greaterThan(0) && receivedQty.lessThan(targetDecimal)) {
      status = 'BLOCKER';
      message = `Принято ${receivedStr} из ${targetStr} ${need.unit}.`;
      ready = false;
    } else {
      status = 'BLOCKER';
      message = `Материал ещё не принят (требуется ${targetStr} ${need.unit}).`;
      ready = false;
    }

    return {
      materialRole: role,
      // Общий резолвер: категорийные группы из 9 + legacy fallback.
      // Для cut-blocking ролей (MAIN_FABRIC/RIB/LINING) лейбл есть
      // всегда; резолвер делает поле устойчивым к любым roleKey.
      roleLabel: getTechCardMaterialRoleLabel(role),
      description: need.description,
      targetQty: targetStr,
      calculatedQty: calculatedQty.toString(),
      purchaseQty: purchaseQty ? purchaseQty.toString() : null,
      receivedQty: receivedStr,
      placedQty: placedStr,
      unit: need.unit,
      ready,
      status,
      workshopNeedId: need.id,
      workshopNeedStatus: need.status,
      cells,
      message,
      manualArrivedQty:
        manualArrivedQty.greaterThan(0) ? manualArrivedQty.toString() : null,
      manuallyUnblocked,
      manualArrivalOverrides:
        manualArrivalRefs.length > 0 ? manualArrivalRefs : undefined,
    };
  }

  /**
   * Конвертация материальной строки в плоский `CutReadinessCheckDto`
   * для секций `blockers` / `warnings`. Используем человекочитаемое
   * название роли, чтобы сообщение в UI читалось без таблицы.
   */
  private materialToCheck(m: CutMaterialReadinessDto): CutReadinessCheckDto {
    const head = m.roleLabel ?? m.materialRole;
    return {
      key: `material.${m.materialRole}.${m.workshopNeedId ?? 'unknown'}`,
      status: m.status,
      title: `${head}: ${m.description}`,
      message: m.message ?? null,
      entityType: m.workshopNeedId ? 'WORKSHOP_NEED' : null,
      entityId: m.workshopNeedId ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// Includes (источник истины для чтения order/workshopNeed)
// ---------------------------------------------------------------------------

const CUT_READINESS_ORDER_INCLUDE = {
  items: { include: { size: true } },
  routeSteps: { select: { id: true } },
  materialRequirements: {
    select: { id: true, materialRole: true },
  },
  techCard: {
    include: {
      materialLines: {
        select: { id: true, materialRole: true },
      },
    },
  },
  patternItem: {
    include: {
      sizeFiles: {
        select: { id: true, sizeId: true, status: true, fileUrl: true },
      },
      materialAreas: {
        select: {
          id: true,
          sizeId: true,
          materialRole: true,
        },
      },
    },
  },
  // Этап «Нанесение на заказе покупателя»: грузим заказные нанесения,
  // чтобы проверить готовность к крою. CUT_PARTS-нанесение с
  // незаполненными параметрами должно блокировать крой; FINISHED_ITEM
  // никогда не блокирует. См. ТЗ §«Бизнес-логика».
  applications: {
    select: {
      id: true,
      type: true,
      stage: true,
      placement: true,
      widthMm: true,
      heightMm: true,
      description: true,
      status: true,
    },
  },
} as const satisfies Prisma.OrderInclude;

const WORKSHOP_NEED_INCLUDE = {
  receiptLines: {
    select: {
      id: true,
      receivedQty: true,
      unit: true,
      status: true,
      cellId: true,
      cell: {
        select: {
          id: true,
          code: true,
          warehouse: { select: { id: true, name: true } },
          line: { select: { id: true, code: true } },
        },
      },
    },
  },
} as const satisfies Prisma.WorkshopNeedInclude;

type WorkshopNeedRowWithReceipts = Prisma.WorkshopNeedGetPayload<{
  include: typeof WORKSHOP_NEED_INCLUDE;
}>;

const MANUAL_ARRIVAL_OVERRIDE_INCLUDE = {
  createdBy: { select: { id: true, fullName: true } },
} as const satisfies Prisma.OrderMaterialArrivalOverrideInclude;

type ManualArrivalOverrideRow =
  Prisma.OrderMaterialArrivalOverrideGetPayload<{
    include: typeof MANUAL_ARRIVAL_OVERRIDE_INCLUDE;
  }>;
