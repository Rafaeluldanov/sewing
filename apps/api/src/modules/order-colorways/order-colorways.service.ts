import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import type {
  OrderColorwayDto,
  OrderColorwaysDto,
  UpsertOrderColorwayDto,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OrdersService } from '../orders/orders.service.js';

/**
 * Модуль «Расцветки заказа» (colorways) — суб-ресурс карточки заказа.
 *
 * Аддитивная фича (флаг `FEATURE_COLORWAYS`): читает/пишет
 * `OrderVariant` + `OrderVariantSize`, НЕ трогая `OrderItem` (он
 * остаётся агрегатом заказа и источником истины для текущего
 * производства/раскроя). За счёт этого выключение фичи = откат: новые
 * таблицы просто перестают читаться.
 *
 * Инвариант: у заказа всегда есть хотя бы одна расцветка (#0 —
 * «первичная», зеркало `Order.color`). Последнюю удалить нельзя.
 *
 * Побочный эффект правок расцветок: после любой мутации (create/
 * update/remove) зовём `OrdersService.resyncColorwayDerived`, чтобы
 * снимок материалов и потребности цеха следовали за техкартой/тиражом
 * расцветки. Без этого правка техкарты расцветки не меняла потребности
 * (они считаются один раз в `startCalculation` и замораживались).
 *
 * Окно редактирования: мутации разрешены ТОЛЬКО в `DRAFT` / `CALCULATION`
 * — том же окне, где `resyncColorwayDerived` пересобирает агрегат
 * `OrderItem` (`canTouchSnapshot`). После запуска расчёта/производства
 * план заказа заморожен (ADR-0006), и правка расцветки НЕ поднялась бы в
 * `OrderItem` — раньше это был тихий no-op: форма «сохраняла», а общий
 * план заказа не менялся. Теперь такие правки отклоняются адресной 409
 * (`ORDER_COLORWAYS_LOCKED`), а UI показывает блок read-only.
 */
@Injectable()
export class OrderColorwaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  // -------------------------------------------------------------------------
  // READ
  // -------------------------------------------------------------------------

  async listForOrder(orderId: string): Promise<OrderColorwaysDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    const [variants, sizes] = await Promise.all([
      this.prisma.orderVariant.findMany({
        where: { orderId },
        orderBy: { ordinal: 'asc' },
        include: {
          sizes: { include: { size: { select: { id: true, code: true } } } },
        },
      }),
      this.prisma.size.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { id: true, code: true },
      }),
    ]);

    return {
      orderId,
      sizes,
      variants: variants.map((v) => this.toVariantDto(v, sizes)),
    };
  }

  // -------------------------------------------------------------------------
  // WRITE
  // -------------------------------------------------------------------------

  async create(
    orderId: string,
    dto: UpsertOrderColorwayDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderColorwaysDto> {
    await this.assertEditableOrder(orderId);

    const last = await this.prisma.orderVariant.findFirst({
      where: { orderId },
      orderBy: { ordinal: 'desc' },
      select: { ordinal: true },
    });
    const nextOrdinal = (last?.ordinal ?? -1) + 1;

    await this.prisma.orderVariant.create({
      data: {
        orderId,
        ordinal: nextOrdinal,
        color: dto.color,
        sizes: {
          create: this.normalizeSizes(dto.sizes),
        },
      },
    });

    await this.orders.resyncColorwayDerived(orderId, actorEmployeeId);
    return this.listForOrder(orderId);
  }

  async update(
    orderId: string,
    variantId: string,
    dto: UpsertOrderColorwayDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderColorwaysDto> {
    await this.assertEditableOrder(orderId);
    const variant = await this.prisma.orderVariant.findFirst({
      where: { id: variantId, orderId },
      select: { id: true },
    });
    if (!variant) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_VARIANT_NOT_FOUND',
        message: 'Расцветка не найдена',
      });
    }
    // Поразмерный план = source of truth формы: заменяем целиком.
    await this.prisma.$transaction([
      this.prisma.orderVariant.update({
        where: { id: variantId },
        data: { color: dto.color },
      }),
      this.prisma.orderVariantSize.deleteMany({ where: { variantId } }),
      this.prisma.orderVariantSize.createMany({
        data: this.normalizeSizes(dto.sizes).map((s) => ({
          ...s,
          variantId,
        })),
      }),
    ]);

    await this.orders.resyncColorwayDerived(orderId, actorEmployeeId);
    return this.listForOrder(orderId);
  }

  async remove(
    orderId: string,
    variantId: string,
    actorEmployeeId?: string | null,
  ): Promise<OrderColorwaysDto> {
    await this.assertEditableOrder(orderId);
    const count = await this.prisma.orderVariant.count({ where: { orderId } });
    if (count <= 1) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ORDER_VARIANT_LAST',
        message: 'Нельзя удалить последнюю расцветку заказа.',
      });
    }
    const variant = await this.prisma.orderVariant.findFirst({
      where: { id: variantId, orderId },
      select: { id: true },
    });
    if (!variant) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_VARIANT_NOT_FOUND',
        message: 'Расцветка не найдена',
      });
    }
    await this.prisma.orderVariant.delete({ where: { id: variantId } });
    await this.orders.resyncColorwayDerived(orderId, actorEmployeeId);
    return this.listForOrder(orderId);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /**
   * Заказ существует И расцветки сейчас можно менять. Окно правки —
   * `DRAFT` / `CALCULATION` (см. `canTouchSnapshot` в
   * `resyncColorwayDerived`): только в нём правка расцветки поднимается в
   * агрегат `OrderItem`. После заморозки (CALCULATION_DONE и далее) молча
   * писать `OrderVariantSize` нельзя — общий план заказа не изменится, а
   * форма «сохранит»; вместо этого отклоняем адресной 409.
   */
  private async assertEditableOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (
      order.status !== OrderStatus.DRAFT &&
      order.status !== OrderStatus.CALCULATION
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: 'ORDER_COLORWAYS_LOCKED',
        message:
          'Расцветки можно менять только пока заказ в статусе «Черновик» или «Расчёт». После запуска расчёта/производства общий план заказа заморожен, и правка расцветки его не изменит. Чтобы редактировать — верните заказ на пересчёт.',
      });
    }
  }

  /** Схлопывает дубли размеров и выкидывает нулевые строки. */
  private normalizeSizes(
    rows: UpsertOrderColorwayDto['sizes'],
  ): Array<{ sizeId: string; qtyPlan: number }> {
    const bySize = new Map<string, number>();
    for (const r of rows) {
      bySize.set(r.sizeId, (bySize.get(r.sizeId) ?? 0) + r.qtyPlan);
    }
    return [...bySize.entries()]
      .filter(([, qty]) => qty > 0)
      .map(([sizeId, qtyPlan]) => ({ sizeId, qtyPlan }));
  }

  private toVariantDto(
    v: {
      id: string;
      ordinal: number;
      color: string;
      sizes: Array<{
        sizeId: string;
        qtyPlan: number;
        size: { id: string; code: string } | null;
      }>;
    },
    allSizes: Array<{ id: string; code: string }>,
  ): OrderColorwayDto {
    const codeById = new Map(allSizes.map((s) => [s.id, s.code]));
    return {
      id: v.id,
      ordinal: v.ordinal,
      color: v.color,
      sizes: v.sizes.map((s) => ({
        sizeId: s.sizeId,
        sizeCode: s.size?.code ?? codeById.get(s.sizeId) ?? '—',
        qtyPlan: s.qtyPlan,
      })),
    };
  }
}
