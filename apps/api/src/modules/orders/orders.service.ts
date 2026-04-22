import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrderStatus } from '@prisma/client';
import type {
  CreateOrderDto,
  ListOrdersQuery,
  OrderDetailDto,
  OrderListItemDto,
  Paginated,
  UpdateOrderDto,
} from '@sewing/shared/orders';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OrderInvalidTransitionException,
  OrderLockedException,
  OrderRouteAlreadyStartedException,
  OrderTechCardAlreadyStartedException,
  RouteTemplateInactiveException,
  RouteTemplateNotFoundException,
} from '../../common/errors.js';
import { aggregateOrder } from './order-aggregator.js';
import { OrderNumberService } from './order-number.service.js';
import { RoutesService } from '../routes/routes.service.js';
import { TechCardsService } from '../tech-cards/tech-cards.service.js';

type OrderWithItems = Prisma.OrderGetPayload<{
  include: {
    items: { include: { size: true } };
    passports: true;
    routeTemplate: true;
    routeSteps: { include: { operation: true } };
    techCard: true;
    materialRequirements: true;
    outsourceRequirements: true;
  };
}>;

type ProductLite = { id: string; name: string; color: string };

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbers: OrderNumberService,
    private readonly routes: RoutesService,
    private readonly techCards: TechCardsService,
  ) {}

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(dto: CreateOrderDto): Promise<OrderDetailDto> {
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
    });
    if (!product) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PRODUCT_NOT_FOUND',
        message: 'Изделие не найдено',
      });
    }
    if (!product.active) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PRODUCT_INACTIVE',
        message: 'Изделие деактивировано',
      });
    }

    // Проверка существования размеров + уникальности (последнее также
    // защищено Zod-схемой, но лучше не доверять клиенту).
    const sizeIds = dto.items.map((i) => i.sizeId);
    const sizes = await this.prisma.size.findMany({
      where: { id: { in: sizeIds } },
    });
    if (sizes.length !== new Set(sizeIds).size) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'SIZE_NOT_FOUND',
        message: 'Один из размеров не найден в справочнике',
      });
    }
    if (new Set(sizeIds).size !== sizeIds.length) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ORDER_DUPLICATE_SIZE',
        message: 'Размер не должен повторяться в одном заказе',
      });
    }

    // Soft-route MVP: если выбран шаблон маршрута — валидируем
    // существование и активность до открытия транзакции, чтобы UI
    // получил адресную ошибку (404 ROUTE_TEMPLATE_NOT_FOUND или
    // 409 ROUTE_TEMPLATE_INACTIVE), а не общий FK-сбой.
    if (dto.routeTemplateId) {
      await this.assertRouteTemplateUsable(dto.routeTemplateId);
    }
    // Tech card MVP (ADR-0022): аналогично route — soft-protection
    // против UI, который раздаёт неактивные значения.
    if (dto.techCardId) {
      await this.techCards.assertTechCardUsable(dto.techCardId);
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const number = await this.numbers.nextNumber(tx);
      return tx.order.create({
        data: {
          number,
          customer: dto.customer ?? null,
          orderDate: new Date(dto.orderDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          // Цвет хранится на заказе, но по умолчанию берём его из продукта
          // (см. `docs/domain.md §5a`).
          color: dto.color ?? product.color,
          comment: dto.comment ?? null,
          status: OrderStatus.DRAFT,
          routeTemplateId: dto.routeTemplateId ?? null,
          techCardId: dto.techCardId ?? null,
          items: {
            create: dto.items.map((i) => ({
              productId: dto.productId,
              sizeId: i.sizeId,
              qtyPlan: i.qtyPlan,
            })),
          },
        },
        include: {
          items: { include: { size: true } },
          passports: true,
          routeTemplate: true,
          routeSteps: { include: { operation: true } },
          techCard: true,
          materialRequirements: true,
          outsourceRequirements: true,
        },
      });
    });

    return this.toDetailDto(order, product, order.color ?? product.color);
  }

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  async list(query: ListOrdersQuery): Promise<Paginated<OrderListItemDto>> {
    const where: Prisma.OrderWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.search && query.search.length > 0) {
      where.number = { contains: query.search, mode: 'insensitive' };
    }

    const orderBy: Prisma.OrderOrderByWithRelationInput = ((): Prisma.OrderOrderByWithRelationInput => {
      switch (query.sort) {
        case 'orderDate_asc':
          return { orderDate: 'asc' };
        case 'orderDate_desc':
          return { orderDate: 'desc' };
        case 'createdAt_asc':
          return { createdAt: 'asc' };
        case 'createdAt_desc':
        default:
          return { createdAt: 'desc' };
      }
    })();

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          items: { include: { product: true } },
          routeTemplate: true,
        },
      }),
    ]);

    const items: OrderListItemDto[] = rows.map((o) => {
      // На MVP один продукт на заказ: берём первый (если есть).
      const firstItem = o.items[0];
      const product = firstItem?.product
        ? {
            id: firstItem.product.id,
            name: firstItem.product.name,
            color: firstItem.product.color,
          }
        : null;
      const qtyPlanTotal = o.items.reduce((s, i) => s + i.qtyPlan, 0);
      return {
        id: o.id,
        number: o.number,
        orderDate: o.orderDate.toISOString(),
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
        status: o.status,
        productId: product?.id ?? null,
        productName: product?.name ?? null,
        color: o.color ?? product?.color ?? null,
        comment: o.comment,
        customer: o.customer,
        dueDate: o.dueDate ? o.dueDate.toISOString() : null,
        qtyPlanTotal,
        routeTemplateId: o.routeTemplateId,
        routeTemplateCode: o.routeTemplate?.code ?? null,
        routeTemplateName: o.routeTemplate?.name ?? null,
      };
    });

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // -------------------------------------------------------------------------
  // DETAIL
  // -------------------------------------------------------------------------

  async getOne(id: string): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        items: { include: { size: true, product: true } },
        passports: true,
        routeTemplate: true,
        routeSteps: {
          orderBy: { index: 'asc' },
          include: { operation: true },
        },
        techCard: true,
        materialRequirements: { orderBy: { sortOrder: 'asc' } },
        outsourceRequirements: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    const firstItem = order.items[0];
    const product = firstItem?.product
      ? {
          id: firstItem.product.id,
          name: firstItem.product.name,
          color: firstItem.product.color,
        }
      : null;
    return this.toDetailDto(order, product, order.color ?? product?.color ?? null);
  }

  // -------------------------------------------------------------------------
  // UPDATE (DRAFT only)
  // -------------------------------------------------------------------------

  async update(id: string, dto: UpdateOrderDto): Promise<OrderDetailDto> {
    const current = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!current) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    }
    if (current.status !== OrderStatus.DRAFT) {
      throw new OrderLockedException(
        'Редактировать можно только заказ в статусе DRAFT',
      );
    }

    // Валидация items
    let productId = dto.productId ?? current.items[0]?.productId;
    if (dto.items && dto.items.length > 0 && !productId) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PRODUCT_REQUIRED',
        message: 'Для заказа со строками обязателен productId',
      });
    }

    if (dto.items) {
      const sizeIds = dto.items.map((i) => i.sizeId);
      if (new Set(sizeIds).size !== sizeIds.length) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'ORDER_DUPLICATE_SIZE',
          message: 'Размер не должен повторяться в одном заказе',
        });
      }
      const sizes = await this.prisma.size.findMany({ where: { id: { in: sizeIds } } });
      if (sizes.length !== new Set(sizeIds).size) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'SIZE_NOT_FOUND',
          message: 'Один из размеров не найден в справочнике',
        });
      }
    }

    if (dto.productId) {
      const p = await this.prisma.product.findUnique({ where: { id: dto.productId } });
      if (!p) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'PRODUCT_NOT_FOUND',
          message: 'Изделие не найдено',
        });
      }
    }

    // Soft-route MVP: смена/сброс шаблона маршрута допустимы только в
    // DRAFT (общий guard выше уже это гарантировал) и только пока snapshot
    // ещё не зафиксирован. Для строгости — повторная проверка snapshot:
    // в DRAFT его и так быть не должно, но это страхует от будущих
    // переходов «PAUSED → DRAFT» и т.п. (см. ADR-0006).
    if (dto.routeTemplateId !== undefined) {
      const snapshotCount = await this.prisma.orderRouteStep.count({
        where: { orderId: id },
      });
      if (snapshotCount > 0) {
        throw new OrderRouteAlreadyStartedException();
      }
      if (dto.routeTemplateId !== null) {
        await this.assertRouteTemplateUsable(dto.routeTemplateId);
      }
    }

    // Tech card MVP (ADR-0022): аналогичная защита по snapshot-у
    // материалов/внешних потребностей. В DRAFT snapshot-а быть не
    // должно, но делаем явный guard, чтобы будущее «PAUSED → DRAFT» не
    // молча затирало старый план.
    if (dto.techCardId !== undefined) {
      const [matCount, outsCount] = await this.prisma.$transaction([
        this.prisma.orderMaterialRequirement.count({ where: { orderId: id } }),
        this.prisma.orderOutsourceRequirement.count({ where: { orderId: id } }),
      ]);
      if (matCount + outsCount > 0) {
        throw new OrderTechCardAlreadyStartedException();
      }
      if (dto.techCardId !== null) {
        await this.techCards.assertTechCardUsable(dto.techCardId);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: {
          customer:
            dto.customer === undefined ? undefined : dto.customer ?? null,
          orderDate: dto.orderDate ? new Date(dto.orderDate) : undefined,
          dueDate:
            dto.dueDate === undefined
              ? undefined
              : dto.dueDate
              ? new Date(dto.dueDate)
              : null,
          color: dto.color === undefined ? undefined : dto.color ?? null,
          comment:
            dto.comment === undefined ? undefined : dto.comment ?? null,
          routeTemplateId:
            dto.routeTemplateId === undefined
              ? undefined
              : dto.routeTemplateId, // null = очистка, string = смена
          techCardId:
            dto.techCardId === undefined ? undefined : dto.techCardId,
        },
      });

      if (dto.items) {
        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.orderItem.createMany({
          data: dto.items.map((i) => ({
            orderId: id,
            productId: productId as string,
            sizeId: i.sizeId,
            qtyPlan: i.qtyPlan,
          })),
        });
      } else if (dto.productId && dto.productId !== current.items[0]?.productId) {
        // Смена продукта без смены состава строк: просто обновить productId
        // у существующих строк. Это всё ещё допустимо, т.к. заказ DRAFT.
        await tx.orderItem.updateMany({
          where: { orderId: id },
          data: { productId: dto.productId },
        });
      }
    });

    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // TRANSITIONS
  // -------------------------------------------------------------------------

  async start(id: string): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    }
    if (order.status !== OrderStatus.DRAFT) {
      throw new OrderInvalidTransitionException(
        'В производство можно запустить только заказ в статусе DRAFT',
      );
    }
    if (order.items.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ORDER_HAS_NO_ITEMS',
        message: 'Нельзя запустить пустой заказ',
      });
    }

    // Soft-route MVP: snapshot маршрута фиксируется в момент запуска
    // заказа. Если шаблон не выбран — ничего не делаем (полная backward
    // compatibility со старым flow). Если выбран — копируем шаги в
    // `OrderRouteStep[]` с теми же `index`-ами, чтобы поздняя правка
    // шаблона не меняла уже запущенные заказы.
    //
    // Snapshot и смена статуса — в одной транзакции: либо заказ
    // запустился с маршрутом, либо без всего (целостность важнее
    // удобства). Шаблон без шагов — допустим: snapshot не пишется,
    // флаг `routeTemplateId` остаётся, никаких ошибок.
    let snapshotSteps: { index: number; operationId: string }[] = [];
    if (order.routeTemplateId) {
      snapshotSteps = await this.routes.getActiveStepsForSnapshot(
        order.routeTemplateId,
      );
    }

    // Tech card MVP (ADR-0022): фиксируем snapshot строк техкарты в
    // той же транзакции, что смена статуса. baseQty = Σ qtyPlan по
    // OrderItem. Никаких формул/коэффициентов: totalQty = qtyPerUnit *
    // baseQty (см. `docs/domain.md §«Техкарты»`).
    const baseQty = order.items.reduce((s, it) => s + it.qtyPlan, 0);
    let techCardLines: Awaited<
      ReturnType<TechCardsService['getLinesForSnapshot']>
    > | null = null;
    if (order.techCardId) {
      techCardLines = await this.techCards.getLinesForSnapshot(
        order.techCardId,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: { status: OrderStatus.IN_PRODUCTION },
      });
      if (snapshotSteps.length > 0) {
        // Защита от двойного snapshot-а: если по какой-то причине
        // OrderRouteStep уже есть (ручной transition / админ-патч в
        // будущем), не дублируем.
        const existing = await tx.orderRouteStep.count({
          where: { orderId: id },
        });
        if (existing === 0) {
          await tx.orderRouteStep.createMany({
            data: snapshotSteps.map((s) => ({
              orderId: id,
              index: s.index,
              operationId: s.operationId,
            })),
          });
        }
      }

      if (techCardLines) {
        const baseDecimal = new Prisma.Decimal(baseQty);
        // Аналогичный idempotent-guard, как у route snapshot.
        const existingMat = await tx.orderMaterialRequirement.count({
          where: { orderId: id },
        });
        if (existingMat === 0 && techCardLines.materialLines.length > 0) {
          await tx.orderMaterialRequirement.createMany({
            data: techCardLines.materialLines.map((l) => ({
              orderId: id,
              sourceTechCardLineId: l.id,
              sortOrder: l.sortOrder,
              name: l.name,
              unit: l.unit,
              qtyPerUnit: l.qtyPerUnit,
              totalQty: l.qtyPerUnit.mul(baseDecimal),
              note: l.note,
            })),
          });
        }
        const existingOuts = await tx.orderOutsourceRequirement.count({
          where: { orderId: id },
        });
        if (existingOuts === 0 && techCardLines.outsourceLines.length > 0) {
          await tx.orderOutsourceRequirement.createMany({
            data: techCardLines.outsourceLines.map((l) => ({
              orderId: id,
              sourceTechCardLineId: l.id,
              sortOrder: l.sortOrder,
              name: l.name,
              unit: l.unit,
              qtyPerUnit: l.qtyPerUnit,
              totalQty:
                l.qtyPerUnit == null ? null : l.qtyPerUnit.mul(baseDecimal),
              vendorName: l.vendorName,
              note: l.note,
            })),
          });
        }
      }
    });

    return this.getOne(id);
  }

  async complete(id: string): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    }
    if (order.status !== OrderStatus.IN_PRODUCTION) {
      throw new OrderInvalidTransitionException(
        'Завершить можно только заказ в статусе IN_PRODUCTION',
      );
    }
    await this.prisma.order.update({
      where: { id },
      data: { status: OrderStatus.DONE },
    });
    return this.getOne(id);
  }

  async cancel(id: string): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    }
    if (order.status === OrderStatus.DONE || order.status === OrderStatus.CANCELLED) {
      throw new OrderInvalidTransitionException(
        'Заказ уже завершён или отменён',
      );
    }
    await this.prisma.order.update({
      where: { id },
      data: { status: OrderStatus.CANCELLED },
    });
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // MAPPERS
  // -------------------------------------------------------------------------

  private async toDetailDto(
    order: OrderWithItems,
    product: ProductLite | null,
    color: string | null,
  ): Promise<OrderDetailDto> {
    // Догружаем справочник размеров для breakdown.
    // Читаем все размеры заказа одним запросом.
    const sizeIds = order.items.map((i) => i.sizeId);
    const sizes = await this.prisma.size.findMany({
      where: { id: { in: sizeIds } },
    });

    const { summary, sizeBreakdown } = aggregateOrder({
      items: order.items,
      sizes,
      passports: order.passports,
    });

    const qtyPlanTotal = summary.qtyPlanTotal;

    return {
      id: order.id,
      number: order.number,
      orderDate: order.orderDate.toISOString(),
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      status: order.status,
      productId: product?.id ?? null,
      productName: product?.name ?? null,
      color: color ?? product?.color ?? null,
      comment: order.comment,
      customer: order.customer,
      dueDate: order.dueDate ? order.dueDate.toISOString() : null,
      qtyPlanTotal,
      routeTemplateId: order.routeTemplateId,
      routeTemplateCode: order.routeTemplate?.code ?? null,
      routeTemplateName: order.routeTemplate?.name ?? null,
      techCardId: order.techCardId,
      techCardCode: order.techCard?.code ?? null,
      techCardName: order.techCard?.name ?? null,
      items: order.items.map((it) => {
        const s = sizes.find((x) => x.id === it.sizeId);
        return {
          id: it.id,
          sizeId: it.sizeId,
          sizeCode: s?.code ?? '—',
          sizeSortOrder: s?.sortOrder ?? Number.MAX_SAFE_INTEGER,
          qtyPlan: it.qtyPlan,
        };
      }).sort((a, b) => a.sizeSortOrder - b.sizeSortOrder),
      summary,
      sizeBreakdown,
      routeSteps: order.routeSteps
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((s) => ({
          id: s.id,
          index: s.index,
          operationId: s.operationId,
          operationCode: s.operation.code,
          operationName: s.operation.name,
        })),
      materialRequirements: order.materialRequirements
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((r) => ({
          id: r.id,
          sortOrder: r.sortOrder,
          name: r.name,
          unit: r.unit,
          qtyPerUnit: r.qtyPerUnit.toString(),
          totalQty: r.totalQty.toString(),
          note: r.note,
        })),
      outsourceRequirements: order.outsourceRequirements
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((r) => ({
          id: r.id,
          sortOrder: r.sortOrder,
          name: r.name,
          unit: r.unit,
          qtyPerUnit: r.qtyPerUnit ? r.qtyPerUnit.toString() : null,
          totalQty: r.totalQty ? r.totalQty.toString() : null,
          vendorName: r.vendorName,
          note: r.note,
        })),
    };
  }

  /**
   * Soft-route MVP: проверяет, что выбранный шаблон существует и
   * активен. Используется и в `create`, и в `update`. На неактивный
   * шаблон отдаём 409 (ROUTE_TEMPLATE_INACTIVE) — это soft-protection
   * против UI, который раздаёт не-активные значения.
   */
  private async assertRouteTemplateUsable(
    routeTemplateId: string,
  ): Promise<void> {
    const tpl = await this.prisma.routeTemplate.findUnique({
      where: { id: routeTemplateId },
      select: { id: true, isActive: true },
    });
    if (!tpl) throw new RouteTemplateNotFoundException();
    if (!tpl.isActive) throw new RouteTemplateInactiveException();
  }
}
