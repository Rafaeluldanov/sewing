import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type OrderExtraCost } from '@prisma/client';
import type {
  CreateOrderExtraCostDto,
  OrderExtraCostDto,
  UpdateOrderExtraCostDto,
} from '@sewing/shared/order-extra-costs';

import { OrderExtraCostNotFoundException } from '../../common/errors.js';
import { assertOrderMaterialCorrectionAllowed } from '../../common/order-material-correction.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Модуль «Прочие / непредвиденные расходы заказа» (этап «Корректировка
 * материалов после просчёта»).
 *
 * См. `prisma/schema.prisma::OrderExtraCost`,
 * `packages/shared/src/order-extra-costs.ts`.
 *
 * Назначение: учесть расходы, которые «вылезают» уже после отправки
 * заказа на просчёт (логистика, аутсорс, штрафы и т.п.), когда состав и
 * материалы из техкарты править нельзя. Это управленческая строка, НЕ
 * складская операция — WorkshopNeed / остатки / движения не
 * затрагиваются. На себестоимость влияет только после
 * `completeCalculation` / `recalculateCostEstimate`
 * (см. `OrderCostEstimatesService`), которые читают активные
 * `OrderExtraCost` с `includeInCostPrice = true`.
 *
 * CRUD разрешён в тех же статусах, что и ручные строки потребности
 * (`CALCULATION` / `CALCULATION_DONE` / `IN_PRODUCTION`, см.
 * `assertOrderMaterialCorrectionAllowed`).
 */
@Injectable()
export class OrderExtraCostsService {
  private readonly logger = new Logger(OrderExtraCostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listForOrder(orderId: string): Promise<OrderExtraCostDto[]> {
    const rows = await this.prisma.orderExtraCost.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { createdBy: { select: { fullName: true } } },
    });
    return rows.map((r) => toDto(r));
  }

  async create(
    orderId: string,
    dto: CreateOrderExtraCostDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderExtraCostDto> {
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

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.orderExtraCost.create({
        data: {
          orderId,
          description: dto.description,
          amount: new Prisma.Decimal(dto.amount),
          currency: dto.currency,
          includeInCostPrice: dto.includeInCostPrice,
          createdAtStatus: order.status,
          comment: dto.comment ?? null,
          createdById: actorEmployeeId ?? null,
        },
      });
      await this.audit.log(
        {
          event: 'ORDER_EXTRA_COST_CREATED',
          entityType: 'ORDER_EXTRA_COST',
          entityId: row.id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId,
            orderStatus: order.status,
            description: dto.description,
            amount: dto.amount,
            currency: dto.currency,
            includeInCostPrice: dto.includeInCostPrice,
          },
        },
        tx,
      );
      return row;
    });

    this.logger.log(
      `event=order_extra_cost.create id=${created.id} order=${orderId}`,
    );
    return this.getOne(created.id);
  }

  async update(
    costId: string,
    dto: UpdateOrderExtraCostDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderExtraCostDto> {
    const existing = await this.prisma.orderExtraCost.findUnique({
      where: { id: costId },
      include: { order: { select: { status: true } } },
    });
    if (!existing) throw new OrderExtraCostNotFoundException();
    assertOrderMaterialCorrectionAllowed(existing.order.status);

    const data: Prisma.OrderExtraCostUpdateInput = {};
    const changedFields: string[] = [];
    if (dto.description !== undefined) {
      data.description = dto.description;
      changedFields.push('description');
    }
    if (dto.amount !== undefined) {
      data.amount = new Prisma.Decimal(dto.amount);
      changedFields.push('amount');
    }
    if (dto.currency !== undefined) {
      data.currency = dto.currency;
      changedFields.push('currency');
    }
    if (dto.includeInCostPrice !== undefined) {
      data.includeInCostPrice = dto.includeInCostPrice;
      changedFields.push('includeInCostPrice');
    }
    if (dto.comment !== undefined) {
      data.comment = dto.comment;
      changedFields.push('comment');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.orderExtraCost.update({ where: { id: costId }, data });
      await this.audit.log(
        {
          event: 'ORDER_EXTRA_COST_UPDATED',
          entityType: 'ORDER_EXTRA_COST',
          entityId: costId,
          employeeId: actorEmployeeId ?? null,
          payload: { orderId: existing.orderId, changedFields },
        },
        tx,
      );
    });

    this.logger.log(
      `event=order_extra_cost.update id=${costId} fields=${changedFields.join(',')}`,
    );
    return this.getOne(costId);
  }

  async delete(
    costId: string,
    actorEmployeeId?: string | null,
  ): Promise<void> {
    const existing = await this.prisma.orderExtraCost.findUnique({
      where: { id: costId },
      include: { order: { select: { status: true } } },
    });
    if (!existing) throw new OrderExtraCostNotFoundException();
    assertOrderMaterialCorrectionAllowed(existing.order.status);

    await this.prisma.$transaction(async (tx) => {
      await tx.orderExtraCost.delete({ where: { id: costId } });
      await this.audit.log(
        {
          event: 'ORDER_EXTRA_COST_DELETED',
          entityType: 'ORDER_EXTRA_COST',
          entityId: costId,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId: existing.orderId,
            description: existing.description,
          },
        },
        tx,
      );
    });
    this.logger.log(`event=order_extra_cost.delete id=${costId}`);
  }

  private async getOne(id: string): Promise<OrderExtraCostDto> {
    const row = await this.prisma.orderExtraCost.findUnique({
      where: { id },
      include: { createdBy: { select: { fullName: true } } },
    });
    if (!row) throw new OrderExtraCostNotFoundException();
    return toDto(row);
  }
}

type OrderExtraCostRow = OrderExtraCost & {
  createdBy?: { fullName: string | null } | null;
};

function toDto(row: OrderExtraCostRow): OrderExtraCostDto {
  return {
    id: row.id,
    orderId: row.orderId,
    description: row.description,
    amount: row.amount.toString(),
    currency: row.currency,
    includeInCostPrice: row.includeInCostPrice,
    createdAtStatus: row.createdAtStatus,
    comment: row.comment,
    createdById: row.createdById,
    createdByName: row.createdBy?.fullName ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
