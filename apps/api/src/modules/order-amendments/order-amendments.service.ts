import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, type Prisma } from '@prisma/client';
import type {
  AmendmentHistoryEntryDto,
  ApplyOperationAmendmentDto,
  ApplyQuantityAmendmentDto,
  ApplyRouteAmendmentDto,
  ApplySizeAmendmentDto,
  OperationAmendmentResultDto,
  OperationAmendmentStateDto,
  QuantityAmendmentResultDto,
  QuantityAmendmentStateDto,
  RouteAmendmentResultDto,
  SizeAmendmentResultDto,
  SizeAmendmentStateDto,
} from '@sewing/shared';
import { planRouteAmendment } from '@sewing/shared';
import { isOrderRouteEditable, isOrderStarted } from '@sewing/shared/orders';
import {
  AmendmentBelowCutException,
  AmendmentMultiVariantUnsupportedException,
  AmendmentOperationAlreadyInRouteException,
  AmendmentOperationBehindFrontierException,
  AmendmentRouteFrontierChangedException,
  AmendmentRouteStepHasWorkException,
  AmendmentSizeAlreadyInOrderException,
  AmendmentSizeHasWorkException,
  OrderNotAmendableException,
  WorkshopNeedsHaveStockException,
} from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { WorkshopNeedsService } from '../workshop-needs/workshop-needs.service.js';

/**
 * Фича «Правка заказа в производстве» (order amendments, флаг
 * `FEATURE_ORDER_AMENDMENTS`) — ФАЗА 1: количество по размерам.
 *
 * После запуска (`IN_PRODUCTION`) план заказа заморожен (ADR-0006).
 * Обычная правка (`OrdersService.update`) относит состав/размеры к
 * «опасным» полям и в не-DRAFT бросает `ORDER_LOCKED`. Здесь — узкий,
 * аддитивный, forward-only путь: меняем плановый тираж по размерам и
 * ДОСТРАИВАЕМ производные снимки (материалы, план операций, задача
 * раскроя), не пересоздавая их и не осиротляя уже выпущенные паспорта.
 *
 * Инварианты amendment-пути:
 *   - работает ТОЛЬКО в `IN_PRODUCTION` (`assertAmendable`);
 *   - план размера нельзя опустить ниже уже раскроенного
 *     (Σ `Passport.qtyCut`, кроме CANCELLED) — раскрой необратим;
 *   - маршрут (`OrderRouteStep`) НЕ трогаем — паспорта ссылаются на его
 *     индексы (см. `OrdersService.rebuildQtyDerivedSnapshotsInTx`);
 *   - потребности (`WorkshopNeed`) пересчитываем best-effort ПОСЛЕ
 *     коммита: если по строкам уже есть движения склада, штатный
 *     пересчёт упрётся в `WORKSHOP_NEEDS_HAVE_STOCK` — тогда не роняем
 *     уже применённую правку, а возвращаем предупреждение «обновите
 *     потребности вручную».
 *
 * Заказы с ≥2 расцветками пока не поддержаны: агрегатная правка размера
 * неоднозначна по цветам, правка per-цвет — следующая фаза.
 */
@Injectable()
export class OrderAmendmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly workshopNeeds: WorkshopNeedsService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // READ — состояние + ограничения для drawer-а
  // -------------------------------------------------------------------------

  async getQuantityState(orderId: string): Promise<QuantityAmendmentStateDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        items: {
          select: {
            sizeId: true,
            qtyPlan: true,
            size: { select: { code: true, sortOrder: true } },
          },
        },
        _count: { select: { variants: true } },
      },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    const cutBySize = await this.cutQtyBySize(orderId);
    const needsHaveStock = await this.hasNeedsWithStock(orderId);

    const rows = order.items
      .slice()
      .sort((a, b) => (a.size?.sortOrder ?? 0) - (b.size?.sortOrder ?? 0))
      .map((it) => ({
        sizeId: it.sizeId,
        sizeCode: it.size?.code ?? '—',
        currentQtyPlan: it.qtyPlan,
        qtyCut: cutBySize.get(it.sizeId) ?? 0,
      }));

    return {
      orderId,
      editable: order.status === OrderStatus.IN_PRODUCTION,
      multiVariant: order._count.variants >= 2,
      needsHaveStock,
      rows,
    };
  }

  // -------------------------------------------------------------------------
  // WRITE — применить правку количества
  // -------------------------------------------------------------------------

  async applyQuantity(
    orderId: string,
    dto: ApplyQuantityAmendmentDto,
    actorEmployeeId?: string | null,
  ): Promise<QuantityAmendmentResultDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        items: { select: { sizeId: true, qtyPlan: true } },
        variants: {
          orderBy: { ordinal: 'asc' },
          select: { id: true },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (order.status !== OrderStatus.IN_PRODUCTION) {
      throw new OrderNotAmendableException();
    }
    if (order.variants.length >= 2) {
      throw new AmendmentMultiVariantUnsupportedException();
    }

    const currentBySize = new Map(order.items.map((it) => [it.sizeId, it.qtyPlan]));
    const cutBySize = await this.cutQtyBySize(orderId);

    // Валидация ДО записи: размер из плана; план не ниже раскроя и не
    // обнуляется (обнуление размера — это правка размерности, отдельная
    // фаза, а не правка количества).
    for (const c of dto.changes) {
      if (!currentBySize.has(c.sizeId)) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'AMENDMENT_SIZE_NOT_IN_ORDER',
          message: `Размер ${c.sizeId} не входит в план заказа.`,
        });
      }
      const cut = cutBySize.get(c.sizeId) ?? 0;
      if (c.newQtyPlan < cut) {
        throw new AmendmentBelowCutException(
          `По размеру уже раскроено ${cut} шт — план нельзя опустить ниже раскроя (${c.newQtyPlan}).`,
        );
      }
      if (c.newQtyPlan < 1) {
        throw new AmendmentBelowCutException(
          'Нельзя обнулить размер в режиме правки количества — используйте изменение размерности.',
        );
      }
    }

    // Только реально изменившиеся строки (no-op не пишем и не аудируем).
    const effective = dto.changes.filter(
      (c) => c.newQtyPlan !== currentBySize.get(c.sizeId),
    );
    if (effective.length === 0) {
      return {
        orderId,
        applied: false,
        needsRecalculated: false,
        warnings: ['Изменений нет — количество совпадает с текущим планом.'],
      };
    }

    const singleVariantId =
      order.variants.length === 1 ? order.variants[0].id : null;

    await this.prisma.$transaction(async (tx) => {
      for (const c of effective) {
        // Агрегат заказа (источник истины для производства/раскроя/payroll).
        await tx.orderItem.updateMany({
          where: { orderId, sizeId: c.sizeId },
          data: { qtyPlan: c.newQtyPlan },
        });
        // Поразмерный план единственной расцветки — держим инвариант
        // OrderItem == Σ OrderVariantSize (строки могло не быть, если
        // размер когда-то был нулевым → upsert).
        if (singleVariantId) {
          await tx.orderVariantSize.upsert({
            where: {
              variantId_sizeId: { variantId: singleVariantId, sizeId: c.sizeId },
            },
            create: {
              variantId: singleVariantId,
              sizeId: c.sizeId,
              qtyPlan: c.newQtyPlan,
            },
            update: { qtyPlan: c.newQtyPlan },
          });
        }
        // Снимок задачи раскроя (read-only для раскройщика — правим только
        // этим путём). Если строки нет (размер добавлен позже) — 0 строк.
        await tx.cuttingTaskSizeRow.updateMany({
          where: { task: { orderId }, sizeId: c.sizeId },
          data: { qtyPlan: c.newQtyPlan },
        });
      }

      // Достраиваем производные снимки под новый тираж (материалы + план
      // операций). Маршрут не трогаем.
      await this.orders.rebuildQtyDerivedSnapshotsInTx(orderId, tx);

      await this.audit.log(
        {
          event: 'ORDER_QTY_AMENDED',
          entityType: 'ORDER',
          entityId: orderId,
          employeeId: actorEmployeeId ?? null,
          payload: {
            reason: dto.reason,
            changes: effective.map((c) => ({
              sizeId: c.sizeId,
              from: currentBySize.get(c.sizeId) ?? null,
              to: c.newQtyPlan,
            })),
          },
        },
        tx,
      );
    });

    const { needsRecalculated, warnings } = await this.recalcNeedsBestEffort(
      orderId,
      actorEmployeeId,
    );
    return { orderId, applied: true, needsRecalculated, warnings };
  }

  // -------------------------------------------------------------------------
  // READ / WRITE — ФАЗА 2: размерность (добавить / убрать размер)
  // -------------------------------------------------------------------------

  async getSizeState(orderId: string): Promise<SizeAmendmentStateDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        patternItemId: true,
        items: {
          select: {
            sizeId: true,
            qtyPlan: true,
            size: { select: { code: true, sortOrder: true } },
          },
        },
        _count: { select: { variants: true } },
      },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    const currentSizeIds = new Set(order.items.map((it) => it.sizeId));
    const [cutBySize, laidSizeIds, needsHaveStock, allSizes, patternSizeIds] =
      await Promise.all([
        this.cutQtyBySize(orderId),
        this.laidSizeIds(orderId),
        this.hasNeedsWithStock(orderId),
        this.prisma.size.findMany({
          orderBy: { sortOrder: 'asc' },
          select: { id: true, code: true },
        }),
        this.patternFileSizeIds(order.patternItemId),
      ]);

    const current = order.items
      .slice()
      .sort((a, b) => (a.size?.sortOrder ?? 0) - (b.size?.sortOrder ?? 0))
      .map((it) => {
        const qtyCut = cutBySize.get(it.sizeId) ?? 0;
        return {
          sizeId: it.sizeId,
          sizeCode: it.size?.code ?? '—',
          qtyPlan: it.qtyPlan,
          qtyCut,
          removable: qtyCut === 0 && !laidSizeIds.has(it.sizeId),
        };
      });

    const available = allSizes
      .filter((s) => !currentSizeIds.has(s.id))
      .map((s) => ({
        sizeId: s.id,
        sizeCode: s.code,
        // Нет лекала у заказа → ограничения нет (inPattern=true).
        inPattern: patternSizeIds === null || patternSizeIds.has(s.id),
      }));

    return {
      orderId,
      editable: order.status === OrderStatus.IN_PRODUCTION,
      multiVariant: order._count.variants >= 2,
      needsHaveStock,
      current,
      available,
    };
  }

  async applySizes(
    orderId: string,
    dto: ApplySizeAmendmentDto,
    actorEmployeeId?: string | null,
  ): Promise<SizeAmendmentResultDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        patternItemId: true,
        items: { select: { sizeId: true, productId: true } },
        variants: { orderBy: { ordinal: 'asc' }, select: { id: true } },
        cuttingTask: {
          select: { id: true, sizeRows: { select: { sortOrder: true } } },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (order.status !== OrderStatus.IN_PRODUCTION) {
      throw new OrderNotAmendableException();
    }
    if (order.variants.length >= 2) {
      throw new AmendmentMultiVariantUnsupportedException();
    }

    const currentSizeIds = new Set(order.items.map((it) => it.sizeId));
    const addIds = dto.add.map((a) => a.sizeId);
    const removeIds = dto.remove;

    // Один размер нельзя одновременно добавлять и удалять.
    const conflict = addIds.find((id) => removeIds.includes(id));
    if (conflict) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'AMENDMENT_SIZE_ADD_REMOVE_CONFLICT',
        message: `Размер ${conflict} указан и на добавление, и на удаление.`,
      });
    }

    // Каталожные размеры добавляемых строк (валидность + код/порядок для
    // снимка раскроя).
    const addSizes = addIds.length
      ? await this.prisma.size.findMany({
          where: { id: { in: addIds } },
          select: { id: true, code: true },
        })
      : [];
    const addSizeById = new Map(addSizes.map((s) => [s.id, s]));

    for (const a of dto.add) {
      if (!addSizeById.has(a.sizeId)) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'AMENDMENT_SIZE_NOT_IN_CATALOG',
          message: `Размер ${a.sizeId} не найден в справочнике.`,
        });
      }
      if (currentSizeIds.has(a.sizeId)) {
        throw new AmendmentSizeAlreadyInOrderException(
          `Размер ${addSizeById.get(a.sizeId)?.code ?? a.sizeId} уже есть в заказе — меняйте его тираж во вкладке «Количество».`,
        );
      }
    }

    // Удаляемые размеры: в заказе И без начатой работы.
    const cutBySize = await this.cutQtyBySize(orderId);
    const laidSizeIds = await this.laidSizeIds(orderId);
    for (const sizeId of removeIds) {
      if (!currentSizeIds.has(sizeId)) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'AMENDMENT_SIZE_NOT_IN_ORDER',
          message: `Размер ${sizeId} не входит в план заказа.`,
        });
      }
      if ((cutBySize.get(sizeId) ?? 0) > 0 || laidSizeIds.has(sizeId)) {
        throw new AmendmentSizeHasWorkException(
          `По размеру уже начата работа (раскрой/настил) — удалить его нельзя.`,
        );
      }
    }

    const productId = order.items[0]?.productId ?? null;
    const singleVariantId =
      order.variants.length === 1 ? order.variants[0].id : null;
    const cuttingTaskId = order.cuttingTask?.id ?? null;
    let nextSortOrder =
      (order.cuttingTask?.sizeRows.reduce(
        (max, r) => Math.max(max, r.sortOrder),
        0,
      ) ?? 0) + 10;

    // Предупреждения (не блокирующие): у лекала нет файла на добавляемый
    // размер → раскрой не пройдёт готовность, пока файл не загрузят.
    const warnings: string[] = [];
    const patternSizeIds = await this.patternFileSizeIds(order.patternItemId);
    if (patternSizeIds) {
      for (const a of dto.add) {
        if (!patternSizeIds.has(a.sizeId)) {
          warnings.push(
            `У лекала нет файла на размер ${addSizeById.get(a.sizeId)?.code ?? a.sizeId} — раскрой по нему не пройдёт готовность, пока файл не загрузят.`,
          );
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // Добавление размеров (только при наличии legacy-product заказа).
      if (productId) {
        for (const a of dto.add) {
          await tx.orderItem.create({
            data: { orderId, productId, sizeId: a.sizeId, qtyPlan: a.qtyPlan },
          });
          if (singleVariantId) {
            await tx.orderVariantSize.upsert({
              where: {
                variantId_sizeId: {
                  variantId: singleVariantId,
                  sizeId: a.sizeId,
                },
              },
              create: {
                variantId: singleVariantId,
                sizeId: a.sizeId,
                qtyPlan: a.qtyPlan,
              },
              update: { qtyPlan: a.qtyPlan },
            });
          }
          if (cuttingTaskId) {
            await tx.cuttingTaskSizeRow.create({
              data: {
                taskId: cuttingTaskId,
                sizeId: a.sizeId,
                sizeCodeSnapshot: addSizeById.get(a.sizeId)?.code ?? '—',
                sortOrder: nextSortOrder,
                qtyPlan: a.qtyPlan,
              },
            });
            nextSortOrder += 10;
          }
        }
      }

      // Удаление размеров (без начатой работы — проверено выше).
      for (const sizeId of removeIds) {
        await tx.cuttingTaskSizeRow.deleteMany({
          where: { task: { orderId }, sizeId },
        });
        await tx.orderVariantSize.deleteMany({
          where: { variant: { orderId }, sizeId },
        });
        await tx.orderItem.deleteMany({ where: { orderId, sizeId } });
      }

      await this.orders.rebuildQtyDerivedSnapshotsInTx(orderId, tx);

      await this.audit.log(
        {
          event: 'ORDER_SIZE_AMENDED',
          entityType: 'ORDER',
          entityId: orderId,
          employeeId: actorEmployeeId ?? null,
          payload: {
            reason: dto.reason,
            add: dto.add.map((a) => ({
              sizeId: a.sizeId,
              code: addSizeById.get(a.sizeId)?.code ?? null,
              qtyPlan: a.qtyPlan,
            })),
            remove: removeIds,
          },
        },
        tx,
      );
    });

    const needs = await this.recalcNeedsBestEffort(orderId, actorEmployeeId);
    return {
      orderId,
      applied: true,
      needsRecalculated: needs.needsRecalculated,
      warnings: [...warnings, ...needs.warnings],
    };
  }

  // -------------------------------------------------------------------------
  // READ / WRITE — ФАЗА 3: добавить операцию в маршрут
  // -------------------------------------------------------------------------

  async getOperationState(
    orderId: string,
  ): Promise<OperationAmendmentStateDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        routeSteps: {
          orderBy: { index: 'asc' },
          select: {
            index: true,
            operationId: true,
            parallelGroup: true,
            rateOverride: true,
            timeNormSecOverride: true,
            pricingModeOverride: true,
            operation: {
              select: {
                name: true,
                code: true,
                category: true,
                pricingMode: true,
                fixedRate: true,
                timeNormMode: true,
                timeNormSec: true,
              },
            },
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    const frontierIndex = await this.frontierIndex(orderId);
    const workedOpIds = await this.operationIdsWithWork(orderId);
    // Операции, уже стоящие в маршруте, из палитры НЕ убираем: одна и та же
    // операция может стоять в маршруте несколько раз (чередующиеся ОТК/ВТО
    // между швейными шагами), и чип нужен, чтобы поставить её снова.
    const stepCountByOpId = new Map<string, number>();
    for (const s of order.routeSteps) {
      stepCountByOpId.set(
        s.operationId,
        (stepCountByOpId.get(s.operationId) ?? 0) + 1,
      );
    }
    const available = await this.prisma.operation.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        category: true,
        pricingMode: true,
        fixedRate: true,
        timeNormMode: true,
        timeNormSec: true,
      },
    });

    return {
      orderId,
      // Окно правки маршрута шире производства: холст обслуживает и
      // расчёт, и цех (см. `ORDER_ROUTE_EDITABLE_STATUSES`). До запуска
      // `frontierIndex = −1`, поэтому `movable`/`removable` ниже сами
      // размораживают всю цепочку — отдельной ветки для расчёта нет.
      editable: isOrderRouteEditable(order.status),
      started: isOrderStarted(order.status),
      frontierIndex,
      steps: order.routeSteps.map((s) => {
        // Шаг СТРОГО впереди фронта: на `frontierIndex` стоит самый
        // дальний паспорт — этот шаг сейчас в работе, его не трогаем.
        const movable = s.index > frontierIndex;
        const pricingMode = s.pricingModeOverride ?? s.operation?.pricingMode;
        return {
          index: s.index,
          operationId: s.operationId,
          operationName: s.operation?.name ?? s.operation?.code ?? '—',
          ahead: s.index >= frontierIndex,
          operationCode: s.operation?.code ?? '',
          operationCategory: s.operation?.category ?? null,
          parallelGroup: s.parallelGroup ?? null,
          rateRub:
            pricingMode === 'FIXED'
              ? decimalToNumber(s.rateOverride ?? s.operation?.fixedRate)
              : null,
          timeNormSec:
            s.operation?.timeNormMode === 'FIXED'
              ? s.timeNormSecOverride ?? s.operation?.timeNormSec ?? null
              : null,
          movable,
          // Выработка висит на ОПЕРАЦИИ, а не на строке маршрута: пока в
          // маршруте остаётся хотя бы одно её вхождение, лишнее убирается
          // свободно. Блокируем только последнее (см. `planRouteAmendment`,
          // нарушение `STEP_HAS_WORK`).
          removable:
            movable &&
            (!workedOpIds.has(s.operationId) ||
              (stepCountByOpId.get(s.operationId) ?? 0) > 1),
        };
      }),
      availableOperations: available.map((op) => ({
        id: op.id,
        code: op.code,
        name: op.name,
        category: op.category ?? null,
        inRouteCount: stepCountByOpId.get(op.id) ?? 0,
        rateRub:
          op.pricingMode === 'FIXED' ? decimalToNumber(op.fixedRate) : null,
        timeNormSec: op.timeNormMode === 'FIXED' ? op.timeNormSec ?? null : null,
      })),
    };
  }

  async applyOperation(
    orderId: string,
    dto: ApplyOperationAmendmentDto,
    actorEmployeeId?: string | null,
  ): Promise<OperationAmendmentResultDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        routeSteps: {
          orderBy: { index: 'asc' },
          select: { id: true, index: true, operationId: true },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (order.status !== OrderStatus.IN_PRODUCTION) {
      throw new OrderNotAmendableException();
    }

    const op = await this.prisma.operation.findUnique({
      where: { id: dto.operationId },
      select: { id: true, name: true, code: true },
    });
    if (!op) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'AMENDMENT_OPERATION_NOT_FOUND',
        message: 'Операция не найдена в справочнике.',
      });
    }
    if (order.routeSteps.some((s) => s.operationId === dto.operationId)) {
      throw new AmendmentOperationAlreadyInRouteException(
        `Операция «${op.name || op.code}» уже есть в маршруте заказа.`,
      );
    }

    const stepCount = order.routeSteps.length;
    const frontier = await this.frontierIndex(orderId);

    // Позиция вставки: afterIndex+1, либо в конец. Вставлять можно только
    // ВПЕРЕДИ фронта (insertIndex > frontier) — чисто аддитивно, без
    // возврата уже сделанной работы.
    let insertIndex: number;
    if (dto.afterIndex == null) {
      insertIndex = stepCount; // append
    } else {
      const exists = order.routeSteps.some((s) => s.index === dto.afterIndex);
      if (!exists) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'AMENDMENT_OPERATION_AFTER_INDEX_INVALID',
          message: `Шаг с индексом ${dto.afterIndex} не найден в маршруте заказа.`,
        });
      }
      if (dto.afterIndex < frontier) {
        throw new AmendmentOperationBehindFrontierException(
          'Операцию можно вставить только после позиции, которую ещё не прошёл ни один паспорт (впереди фронта производства).',
        );
      }
      insertIndex = dto.afterIndex + 1;
    }

    await this.prisma.$transaction(async (tx) => {
      // Сдвигаем хвост снимка вверх (index+1). От большего индекса к
      // меньшему — иначе @@unique([orderId, index]) ловит промежуточную
      // коллизию.
      const toShift = order.routeSteps
        .filter((s) => s.index >= insertIndex)
        .sort((a, b) => b.index - a.index);
      for (const s of toShift) {
        await tx.orderRouteStep.update({
          where: { id: s.id },
          data: { index: s.index + 1 },
        });
      }
      // Паспорта, стоящие на сдвинутых индексах, двигаем следом. По
      // правилу «вперёди фронта» таких нет, но пишем для консистентности
      // снимка (Passport.currentRouteStepIndex — мягкий указатель).
      await tx.passport.updateMany({
        where: { orderId, currentRouteStepIndex: { gte: insertIndex } },
        data: { currentRouteStepIndex: { increment: 1 } },
      });

      await tx.orderRouteStep.create({
        data: {
          orderId,
          index: insertIndex,
          operationId: dto.operationId,
          parallelGroup: null,
        },
      });

      // Достраиваем плановую стоимость/время: recalculateAndWriteFromSnapshot
      // считает ПО СНИМКУ, поэтому добавленная операция входит в план.
      await this.orders.rebuildQtyDerivedSnapshotsInTx(orderId, tx);

      await this.audit.log(
        {
          event: 'ORDER_OPERATION_ADDED',
          entityType: 'ORDER',
          entityId: orderId,
          employeeId: actorEmployeeId ?? null,
          payload: {
            reason: dto.reason,
            operationId: dto.operationId,
            operationName: op.name || op.code,
            insertedIndex: insertIndex,
            afterIndex: dto.afterIndex ?? null,
          },
        },
        tx,
      );
    });

    return { orderId, applied: true, insertedIndex: insertIndex, warnings: [] };
  }

  /**
   * Правка маршрута целиком (холст «Изменить маршрут» — карточка «Маршрут
   * операций» на вкладке «Производство» и вкладка «Маршрут» drawer-а
   * «Изменить в производстве»): состав, порядок и параллельные группы.
   *
   * Окно — `ORDER_ROUTE_EDITABLE_STATUSES` (всё, кроме `DONE`/`CANCELLED`):
   * маршрут меняют и на расчёте, и на ходу в цеху. Разделение проходит не
   * по статусу, а по фронту производства: до запуска паспортов нет,
   * `frontierIndex = −1`, замороженный префикс пуст и правится вся
   * цепочка; после запуска фронт режет её ровно там, куда дошла работа.
   *
   * Клиент присылает весь целевой маршрут; что добавлено/убрано/
   * переставлено, считает чистый `planRouteAmendment` — он же стережёт
   * инварианты:
   *   - замороженный префикс (`index <= frontierIndex`) обязан совпасть
   *     один в один: эти шаги паспорта прошли или проходят сейчас;
   *   - убрать шаг можно только если по его операции в заказе нет ни одной
   *     записи выработки (`OperationEntry`);
   *   - дубли операции в маршруте запрещены (доска и подстановки дедуплят
   *     по `operationId`).
   *
   * `Passport.currentRouteStepIndex` НЕ трогаем: по построению ни один
   * паспорт не стоит на индексе больше `frontierIndex`, а меняем мы только
   * хвост за ним.
   *
   * После успеха выставляем `Order.routeCustomizedAt` — с этого момента
   * снимок шагов главнее шаблона, и `syncOrderRouteStepsSnapshot` больше
   * не пересобирает маршрут из `RouteTemplate` (иначе «Пересчитать план
   * операций» на расчёте молча откатил бы правку).
   */
  async applyRoute(
    orderId: string,
    dto: ApplyRouteAmendmentDto,
    actorEmployeeId?: string | null,
  ): Promise<RouteAmendmentResultDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        routeSteps: {
          orderBy: { index: 'asc' },
          select: {
            id: true,
            index: true,
            operationId: true,
            parallelGroup: true,
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (!isOrderRouteEditable(order.status)) {
      throw new OrderNotAmendableException(
        'Заказ закрыт — маршрут в нём уже не меняется.',
      );
    }
    const started = isOrderStarted(order.status);
    // Причина обязательна только у запущенного заказа: там правка задевает
    // идущую работу, и журнал должен объяснять зачем. До запуска маршрут —
    // обычная часть плана (схема поэтому причину не требует, статуса она
    // не знает — см. `ApplyRouteAmendmentSchema`).
    const reason = dto.reason?.trim() ?? '';
    if (started && reason.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'AMENDMENT_REASON_REQUIRED',
        message: 'Укажите причину правки маршрута заказа в производстве.',
      });
    }

    const targetIds = dto.steps.map((s) => s.operationId);
    // Имена нужны и для убираемых шагов (их нет в целевом маршруте) —
    // читаем объединение, чтобы сводка собиралась без доп. запросов.
    const operations = await this.prisma.operation.findMany({
      where: {
        id: { in: [...new Set([...targetIds, ...order.routeSteps.map((s) => s.operationId)])] },
      },
      select: { id: true, name: true, code: true, active: true },
    });
    const opById = new Map(operations.map((o) => [o.id, o]));
    const unknown = targetIds.find((id) => !opById.has(id));
    if (unknown) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'AMENDMENT_OPERATION_NOT_FOUND',
        message: 'Операция не найдена в справочнике.',
      });
    }
    const currentIds = new Set(order.routeSteps.map((s) => s.operationId));
    const inactiveNew = targetIds.find(
      (id) => !currentIds.has(id) && !opById.get(id)?.active,
    );
    if (inactiveNew) {
      const op = opById.get(inactiveNew)!;
      throw new BadRequestException({
        statusCode: 400,
        code: 'AMENDMENT_OPERATION_INACTIVE',
        message: `Операция «${op.name || op.code}» архивная — добавить её в маршрут нельзя.`,
      });
    }

    const frontier = await this.frontierIndex(orderId);
    const workedOpIds = await this.operationIdsWithWork(orderId);

    const planned = planRouteAmendment(
      order.routeSteps,
      dto.steps.map((s) => ({
        operationId: s.operationId,
        parallelGroup: s.parallelGroup ?? null,
        sourceIndex: s.sourceIndex ?? null,
      })),
      frontier,
      workedOpIds,
    );
    if (!planned.ok) {
      const v = planned.violation;
      if (v.code === 'DUPLICATE_IN_PARALLEL_GROUP') {
        const op = opById.get(v.operationId);
        throw new AmendmentOperationAlreadyInRouteException(
          `Операция «${op?.name || op?.code || '?'}» стоит дважды в одной параллельной группе — так группа никогда не закроется.`,
        );
      }
      if (v.code === 'STEP_HAS_WORK') {
        const op = opById.get(v.operationId);
        throw new AmendmentRouteStepHasWorkException(
          `По операции «${op?.name || op?.code || '?'}» уже есть выработка — убрать её из маршрута нельзя.`,
        );
      }
      throw new AmendmentRouteFrontierChangedException(
        `Шаг ${v.index + 1} уже проходят паспорта — менять его порядок или убирать нельзя. Обновите страницу и повторите правку.`,
      );
    }

    const plan = planned.plan;
    const nameOf = (id: string) => {
      const op = opById.get(id);
      return op?.name || op?.code || '?';
    };

    const summaryParts: string[] = [];
    for (const p of plan.added) {
      const prev = plan.placements[p.index - 1];
      summaryParts.push(
        `+ «${nameOf(p.operationId)}» ${
          prev ? `после «${nameOf(prev.operationId)}»` : 'в начало'
        }`,
      );
    }
    for (const id of plan.removedOperationIds) {
      summaryParts.push(`− «${nameOf(id)}»`);
    }
    // По placement, а не по operationId: одна операция может стоять в
    // маршруте несколько раз, и переставлено конкретное вхождение.
    for (const p of plan.moved) {
      summaryParts.push(`«${nameOf(p.operationId)}» → шаг ${p.index + 1}`);
    }
    const summary = summaryParts.join('; ');

    if (plan.noop) {
      return {
        orderId,
        applied: false,
        addedCount: 0,
        removedCount: 0,
        movedCount: 0,
        summary: 'Изменений нет',
        warnings: ['Маршрут не изменился — сохранять нечего.'],
      };
    }

    // Ключ — ПОЗИЦИЯ снимка (`index`), а не операция: при повторах операции
    // в маршруте (чередующиеся ОТК/ВТО) по `operationId` строки неразличимы,
    // и вторая позиция затирала бы первую вместе с её per-order расценкой,
    // нормой времени и поразмерными переопределениями.
    const stepByIndex = new Map(order.routeSteps.map((s) => [s.index, s]));
    const removedStepIds = order.routeSteps
      .filter((s) => plan.removedIndexes.includes(s.index))
      .map((s) => s.id);

    await this.prisma.$transaction(async (tx) => {
      // Фронт мог уехать вперёд, пока менеджер собирал маршрут: перечи-
      // тываем его ВНУТРИ транзакции и отказываем, если сдвинулся. Иначе
      // перекладка индексов задела бы шаг, на который уже встал паспорт.
      const agg = await tx.passport.aggregate({
        where: { orderId, status: { not: 'CANCELLED' } },
        _max: { currentRouteStepIndex: true },
      });
      if ((agg._max.currentRouteStepIndex ?? -1) !== frontier) {
        throw new AmendmentRouteFrontierChangedException(
          'Фронт производства сдвинулся, пока вы правили маршрут. Обновите страницу и повторите правку.',
        );
      }

      // Хвост за фронтом паркуем в отрицательные индексы: иначе
      // перестановка ловит промежуточную коллизию @@unique([orderId, index]).
      for (const s of order.routeSteps) {
        if (s.index <= frontier) continue;
        await tx.orderRouteStep.update({
          where: { id: s.id },
          data: { index: -(s.index + 1) },
        });
      }

      if (removedStepIds.length > 0) {
        await tx.orderRouteStep.deleteMany({
          where: { id: { in: removedStepIds } },
        });
      }

      for (const p of plan.placements) {
        if (p.index <= frontier) continue; // замороженный префикс не трогаем
        const existing =
          p.fromIndex === null ? undefined : stepByIndex.get(p.fromIndex);
        if (existing) {
          await tx.orderRouteStep.update({
            where: { id: existing.id },
            data: { index: p.index, parallelGroup: p.parallelGroup },
          });
        } else {
          await tx.orderRouteStep.create({
            data: {
              orderId,
              index: p.index,
              operationId: p.operationId,
              parallelGroup: p.parallelGroup,
            },
          });
        }
      }

      // Снимок шагов стал главнее шаблона — фиксируем это ДО пересчёта
      // плана: `recalculateAndWrite*` читает флаг и считает по снимку.
      await tx.order.update({
        where: { id: orderId },
        data: { routeCustomizedAt: new Date() },
      });

      // План стоимости/времени считается ПО СНИМКУ — после перекладки
      // индексов достраиваем производные. Материалы не трогаем: состав
      // операций на снимок `OrderMaterialRequirement` не влияет, а на
      // `CALCULATION_DONE` его пересборка задела бы уже посчитанное
      // закупщиком (поэтому здесь узкий пересчёт, а не общий
      // `rebuildQtyDerivedSnapshotsInTx` из правки количества).
      await this.orders.rebuildRouteDerivedSnapshotsInTx(orderId, tx);

      await this.audit.log(
        {
          event: 'ORDER_ROUTE_AMENDED',
          entityType: 'ORDER',
          entityId: orderId,
          employeeId: actorEmployeeId ?? null,
          payload: {
            reason,
            summary,
            added: plan.addedOperationIds,
            removed: plan.removedOperationIds,
            moved: plan.movedOperationIds,
            frontierIndex: frontier,
          },
        },
        tx,
      );
    });

    return {
      orderId,
      applied: true,
      addedCount: plan.addedOperationIds.length,
      removedCount: plan.removedOperationIds.length,
      movedCount: plan.movedOperationIds.length,
      summary,
      warnings: [],
    };
  }

  // -------------------------------------------------------------------------
  // READ — журнал правок (read-only, для карточки заказа)
  // -------------------------------------------------------------------------

  /**
   * Журнал правок заказа в производстве: события `ORDER_QTY_AMENDED` /
   * `ORDER_SIZE_AMENDED` / `ORDER_OPERATION_ADDED` /
   * `ORDER_TECH_CARD_AMENDED` / `ORDER_APPLICATIONS_REPLACED` из
   * `AuditLog`, с уже собранным
   * человекочитаемым `summary` (коды размеров и имя операции подставлены) и
   * именем автора. Сортировка — свежие сверху.
   *
   * `ORDER_TECH_CARD_AMENDED` пишет не этот модуль, а
   * `OrdersService.resyncTechCardDerived` — правка спецификации техкарты
   * идёт своим эндпоинтом, но для менеджера это такая же правка заказа
   * после расчёта, и жить ей место в одном журнале.
   */
  async getHistory(orderId: string): Promise<AmendmentHistoryEntryDto[]> {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          {
            entityType: 'ORDER',
            entityId: orderId,
            event: {
              in: [
                'ORDER_QTY_AMENDED',
                'ORDER_SIZE_AMENDED',
                'ORDER_OPERATION_ADDED',
                'ORDER_ROUTE_AMENDED',
                'ORDER_TECH_CARD_AMENDED',
              ],
            },
          },
          {
            // Нанесения пишут аудит на свой `entityType` и правятся
            // своим эндпоинтом, но правка ПОСЛЕ расчёта — это правка
            // заказа в производстве, и место ей в общем журнале.
            // Черновиковые правки (`lateEdit = false`) сюда не берём:
            // журнал показывают с «Расчёт завершён», а до него список
            // нанесений менялся десятки раз по ходу оформления.
            entityType: 'ORDER_APPLICATION',
            entityId: orderId,
            event: 'ORDER_APPLICATIONS_REPLACED',
            payload: { path: ['lateEdit'], equals: true },
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        event: true,
        payload: true,
        employeeId: true,
        createdAt: true,
      },
    });
    if (logs.length === 0) return [];

    // Резолвим коды размеров и имена акторов пачкой.
    const sizeIds = new Set<string>();
    const employeeIds = new Set<string>();
    for (const l of logs) {
      if (l.employeeId) employeeIds.add(l.employeeId);
      const p = (l.payload ?? {}) as Record<string, unknown>;
      if (l.event === 'ORDER_QTY_AMENDED') {
        for (const c of (p.changes as { sizeId?: string }[]) ?? []) {
          if (c.sizeId) sizeIds.add(c.sizeId);
        }
      } else if (l.event === 'ORDER_SIZE_AMENDED') {
        for (const s of (p.remove as string[]) ?? []) {
          if (typeof s === 'string') sizeIds.add(s);
        }
        for (const a of (p.add as { sizeId?: string; code?: string }[]) ?? []) {
          if (a.sizeId && !a.code) sizeIds.add(a.sizeId);
        }
      }
    }

    const [sizes, employees] = await Promise.all([
      sizeIds.size
        ? this.prisma.size.findMany({
            where: { id: { in: [...sizeIds] } },
            select: { id: true, code: true },
          })
        : Promise.resolve([] as { id: string; code: string }[]),
      employeeIds.size
        ? this.prisma.employee.findMany({
            where: { id: { in: [...employeeIds] } },
            select: { id: true, fullName: true },
          })
        : Promise.resolve([] as { id: string; fullName: string }[]),
    ]);
    const codeById = new Map(sizes.map((s) => [s.id, s.code]));
    const nameById = new Map(employees.map((e) => [e.id, e.fullName]));

    return logs.map((l) => {
      const p = (l.payload ?? {}) as Record<string, unknown>;
      let kind: AmendmentHistoryEntryDto['kind'];
      let summary: string;
      if (l.event === 'ORDER_QTY_AMENDED') {
        kind = 'quantity';
        const changes =
          (p.changes as { sizeId: string; from: number | null; to: number }[]) ??
          [];
        summary =
          'Количество: ' +
          changes
            .map(
              (c) =>
                `${codeById.get(c.sizeId) ?? '?'} ${c.from ?? '?'}→${c.to}`,
            )
            .join(', ');
      } else if (l.event === 'ORDER_SIZE_AMENDED') {
        kind = 'size';
        const adds = (
          (p.add as { sizeId: string; code: string | null; qtyPlan: number }[]) ??
          []
        ).map(
          (a) => `+${a.code ?? codeById.get(a.sizeId) ?? '?'} (${a.qtyPlan})`,
        );
        const rems = ((p.remove as string[]) ?? []).map(
          (s) => `−${codeById.get(s) ?? '?'}`,
        );
        summary = 'Размерность: ' + [...adds, ...rems].join(', ');
      } else if (l.event === 'ORDER_ROUTE_AMENDED') {
        kind = 'operation';
        // `summary` собран при правке (имена операций уже подставлены).
        summary = 'Маршрут: ' + ((p.summary as string) ?? 'правка маршрута');
      } else if (l.event === 'ORDER_TECH_CARD_AMENDED') {
        kind = 'materials';
        // `summary` собран на месте правки (там известны имена материалов
        // и параметров) — здесь только префикс раздела.
        summary = 'Материалы: ' + ((p.summary as string) ?? 'правка спецификации');
      } else if (l.event === 'ORDER_APPLICATIONS_REPLACED') {
        kind = 'application';
        const added = (p.createdCount as number) ?? 0;
        const changed = (p.updatedCount as number) ?? 0;
        const removedCnt = (p.removedCount as number) ?? 0;
        const parts: string[] = [];
        if (added > 0) parts.push(`добавлено ${added}`);
        if (changed > 0) parts.push(`изменено ${changed}`);
        if (removedCnt > 0) parts.push(`удалено ${removedCnt}`);
        summary =
          'Нанесение: ' +
          (parts.length > 0
            ? `${parts.join(', ')} (всего ${(p.nextCount as number) ?? 0})`
            : 'список сохранён без изменений');
      } else {
        kind = 'operation';
        const opName = (p.operationName as string) ?? '?';
        const idx = (p.insertedIndex as number) ?? 0;
        summary = `Добавлена операция «${opName}» на позицию ${idx + 1}`;
      }
      return {
        id: l.id,
        occurredAt: l.createdAt.toISOString(),
        actorName: l.employeeId ? nameById.get(l.employeeId) ?? null : null,
        kind,
        reason: (p.reason as string) ?? null,
        summary,
      };
    });
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /**
   * Фронт производства: максимальный `Passport.currentRouteStepIndex`
   * среди не-отменённых паспортов (−1 если паспортов нет). Дальше него
   * можно вставлять операцию.
   */
  private async frontierIndex(orderId: string): Promise<number> {
    const agg = await this.prisma.passport.aggregate({
      where: { orderId, status: { not: 'CANCELLED' } },
      _max: { currentRouteStepIndex: true },
    });
    return agg._max.currentRouteStepIndex ?? -1;
  }

  /**
   * Операции этого заказа, по которым уже есть записи выработки
   * (`OperationEntry` через паспорта заказа). Такой шаг нельзя убрать из
   * маршрута, даже если он формально впереди фронта: на операцию
   * ссылаются сдельные начисления.
   */
  private async operationIdsWithWork(orderId: string): Promise<Set<string>> {
    const rows = await this.prisma.operationEntry.findMany({
      where: { passport: { orderId } },
      select: { operationId: true },
      distinct: ['operationId'],
    });
    return new Set(rows.map((r) => r.operationId));
  }

  /**
   * Пересчёт потребностей best-effort ПОСЛЕ коммита правки: стоп-гейт по
   * стоку (или отсутствие активной калькуляции) не должен откатывать уже
   * применённую правку. Возвращает флаг + человекочитаемые warnings.
   */
  private async recalcNeedsBestEffort(
    orderId: string,
    actorEmployeeId?: string | null,
  ): Promise<{ needsRecalculated: boolean; warnings: string[] }> {
    const warnings: string[] = [];
    try {
      await this.workshopNeeds.calculateForOrder(
        orderId,
        { force: false },
        actorEmployeeId ?? null,
      );
      return { needsRecalculated: true, warnings };
    } catch (err) {
      if (err instanceof WorkshopNeedsHaveStockException) {
        warnings.push(
          'Потребности не пересчитаны автоматически: по строкам уже есть движения склада. Проверьте и обновите их вручную на экране «Потребности».',
        );
      } else {
        warnings.push(
          'Потребности не удалось пересчитать автоматически — обновите их вручную на экране «Потребности».',
        );
      }
      return { needsRecalculated: false, warnings };
    }
  }

  /** Размеры, уже попавшие в настилы раскроя (perLayerQty > 0). */
  private async laidSizeIds(orderId: string): Promise<Set<string>> {
    const rows = await this.prisma.cuttingTaskLaySize.findMany({
      where: {
        lay: { task: { orderId } },
        perLayerQty: { gt: 0 },
        sizeId: { not: null },
      },
      select: { sizeId: true },
    });
    return new Set(
      rows
        .map((r) => r.sizeId)
        .filter((id): id is string => id !== null),
    );
  }

  /**
   * Размеры, на которые у лекала заказа есть активный файл
   * (`PatternSizeFile.fileUrl != null`). `null` — у заказа нет лекала
   * (ограничения по размерам нет).
   */
  private async patternFileSizeIds(
    patternItemId: string | null,
  ): Promise<Set<string> | null> {
    if (!patternItemId) return null;
    const files = await this.prisma.patternSizeFile.findMany({
      where: { patternItemId, status: 'ACTIVE', fileUrl: { not: null } },
      select: { sizeId: true },
    });
    return new Set(files.map((f) => f.sizeId));
  }

  /** Σ `Passport.qtyCut` по размеру (кроме CANCELLED) — нижняя граница. */
  private async cutQtyBySize(orderId: string): Promise<Map<string, number>> {
    const grouped = await this.prisma.passport.groupBy({
      by: ['sizeId'],
      where: { orderId, status: { not: 'CANCELLED' } },
      _sum: { qtyCut: true },
    });
    return new Map(grouped.map((g) => [g.sizeId, g._sum.qtyCut ?? 0]));
  }

  /** Есть ли строки потребности с движениями склада (блокируют пересчёт). */
  private async hasNeedsWithStock(orderId: string): Promise<boolean> {
    const count = await this.prisma.workshopNeed.count({
      where: { orderId, stockMovements: { some: {} } },
    });
    return count > 0;
  }
}

/**
 * `Prisma.Decimal` → number. `null`/`undefined` пробрасываем как `null`:
 * в DTO drawer-а это значит «расценки нет» (окладная или поразмерная
 * операция), а не «ноль рублей».
 */
function decimalToNumber(
  value: Prisma.Decimal | null | undefined,
): number | null {
  return value != null ? value.toNumber() : null;
}
