import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import {
  ORDER_COST_ESTIMATE_LINE_KIND_LABELS,
  type CompleteOrderCalculationDto,
  type OrderCostEstimateDto,
  type OrderCostEstimateLineDto,
  type OrderCostEstimateStatus,
  type ReopenOrderCalculationDto,
} from '@sewing/shared/order-cost-estimates';
import {
  getWorkshopNeedKind,
  type MoneyCurrency,
} from '@sewing/shared/workshop-needs';
import {
  OrderCalculationIncompleteException,
  OrderCalculationInvalidStatusException,
  OrderCalculationUsdRateRequiredException,
} from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Сервис «Себестоимость заказа» (см.
 * `prisma/schema.prisma::OrderCostEstimate`,
 * `packages/shared/src/order-cost-estimates.ts`).
 *
 * Отвечает за:
 *   - `completeCalculation` — на основании активных
 *     `WorkshopNeed` создаёт `OrderCostEstimate(+lines)`,
 *     обновляет snapshot-поля заказа и переводит статус в
 *     `CALCULATION_DONE`;
 *   - `reopenCalculation`  — помечает активный расчёт как
 *     `REVOKED`, чистит snapshot-поля заказа, возвращает статус в
 *     `CALCULATION`. `WorkshopNeed`, `PurchaseOrder` и
 *     `PurchaseReceipt` не трогаются — только меняем сам
 *     `Order.status` и историю расчётов.
 *
 * Расчёт `WorkshopNeed` (`WorkshopNeedsService.calculateForOrder`)
 * не вызывается отсюда — мы используем уже существующие строки.
 *
 * RBAC — на уровне контроллеров (`@Roles('ADMIN','SHOP_MANAGER')`).
 */
@Injectable()
export class OrderCostEstimatesService {
  private readonly logger = new Logger(OrderCostEstimatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Завершить расчёт по заказу: посчитать `OrderCostEstimate` из
   * активных `WorkshopNeed`, перевести заказ в `CALCULATION_DONE`.
   *
   * Возвращает только что созданный `OrderCostEstimateDto` —
   * `OrdersService.getOne` подгрузит его как `currentCostEstimate`
   * на следующем GET, отдельный round-trip за заказом не делаем.
   */
  async completeCalculation(
    orderId: string,
    dto: CompleteOrderCalculationDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderCostEstimateDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (order.status !== OrderStatus.CALCULATION) {
      throw new OrderCalculationInvalidStatusException(
        `Завершить расчёт можно только из статуса «Расчёт» (текущий: ${order.status}).`,
      );
    }

    // Берём ВСЕ строки (исключая CANCELLED) — это и есть «активные»
    // потребности заказа. Сортируем стабильно по createdAt+id, чтобы
    // строки расчёта ложились в предсказуемом порядке.
    const needs = await this.prisma.workshopNeed.findMany({
      where: { orderId, NOT: { status: 'CANCELLED' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        selectedSupplier: { select: { id: true, name: true } },
        selectedSupplierCatalogItem: { select: { id: true, name: true } },
      },
    });

    // Валидация строк до изменения данных. Считаем суммы в Decimal,
    // чтобы не терять точность копеек.
    type ValidLine = {
      need: (typeof needs)[number];
      finalQty: Prisma.Decimal;
      quotedPrice: Prisma.Decimal;
      currency: MoneyCurrency;
    };

    const validated: ValidLine[] = [];
    const errors: { needId: string; description: string; reason: string }[] = [];
    let hasUsd = false;

    for (const n of needs) {
      const finalQtySource = n.purchaseQty ?? n.calculatedQty;
      const finalQty = new Prisma.Decimal(finalQtySource ?? 0);
      if (!finalQty.greaterThan(0)) {
        errors.push({
          needId: n.id,
          description: n.description,
          reason: 'Не задано «К закупке» (или = 0).',
        });
        continue;
      }
      if (n.quotedPrice == null) {
        errors.push({
          needId: n.id,
          description: n.description,
          reason: 'Не указана цена.',
        });
        continue;
      }
      const quotedPrice = new Prisma.Decimal(n.quotedPrice);
      if (!quotedPrice.greaterThan(0)) {
        errors.push({
          needId: n.id,
          description: n.description,
          reason: 'Цена должна быть > 0.',
        });
        continue;
      }
      const currencyRaw = (n.quotedCurrency ?? '').toUpperCase();
      if (currencyRaw !== 'RUB' && currencyRaw !== 'USD') {
        errors.push({
          needId: n.id,
          description: n.description,
          reason: 'Не выбрана валюта (RUB / USD).',
        });
        continue;
      }
      const currency = currencyRaw as MoneyCurrency;
      if (currency === 'USD') hasUsd = true;
      validated.push({ need: n, finalQty, quotedPrice, currency });
    }

    if (errors.length > 0) {
      throw new OrderCalculationIncompleteException(
        `Не все строки готовы к завершению расчёта (${errors.length}).`,
        errors,
      );
    }

    // Курс USD: обязателен, если есть USD-строки. На MVP считаем
    // только USD→RUB; для RUB-only заказа курс может быть null.
    let usdRateRub: Prisma.Decimal | null = null;
    if (hasUsd) {
      if (!dto.usdRateRub) {
        throw new OrderCalculationUsdRateRequiredException();
      }
      usdRateRub = new Prisma.Decimal(dto.usdRateRub);
      if (!usdRateRub.greaterThan(0)) {
        throw new OrderCalculationUsdRateRequiredException();
      }
    }

    // Считаем итоги по строкам. Округление к 2 знакам — копейки.
    const round2 = (d: Prisma.Decimal): Prisma.Decimal =>
      d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    const computed = validated.map((v) => {
      const lineTotalOriginal = round2(v.finalQty.mul(v.quotedPrice));
      const lineTotalRub =
        v.currency === 'USD' && usdRateRub
          ? round2(lineTotalOriginal.mul(usdRateRub))
          : lineTotalOriginal;
      const kind = getWorkshopNeedKind({
        sourceType: v.need.sourceType,
        calculationMethod: v.need.calculationMethod,
      });
      const supplierNameSnapshot =
        (v.need as unknown as { selectedSupplier?: { name: string } | null })
          .selectedSupplier?.name ?? v.need.supplierNameText ?? null;
      const purchaseItemNameSnapshot =
        (v.need as unknown as {
          selectedSupplierCatalogItem?: { name: string } | null;
        }).selectedSupplierCatalogItem?.name ??
        v.need.purchaseItemNameText ??
        null;
      return {
        v,
        lineTotalOriginal,
        lineTotalRub,
        kind,
        supplierNameSnapshot,
        purchaseItemNameSnapshot,
      };
    });

    const totalCostRub = computed.reduce(
      (acc, c) => acc.add(c.lineTotalRub),
      new Prisma.Decimal(0),
    );

    // Транзакция: создаём estimate + lines, обновляем snapshot-поля
    // заказа и переводим статус. Аудит — двумя строками
    // (`ORDER_COST_ESTIMATE_CREATED` и `ORDER_CALCULATION_COMPLETED`).
    const result = await this.prisma.$transaction(async (tx) => {
      const lastVersionAgg = await tx.orderCostEstimate.aggregate({
        where: { orderId },
        _max: { version: true },
      });
      const nextVersion = (lastVersionAgg._max.version ?? 0) + 1;

      const estimate = await tx.orderCostEstimate.create({
        data: {
          orderId,
          version: nextVersion,
          status: 'COMPLETED',
          totalCostRub: round2(totalCostRub),
          usdRateRub,
          completedById: actorEmployeeId ?? null,
          comment: dto.comment ?? null,
          lines: {
            create: computed.map((c) => ({
              workshopNeedId: c.v.need.id,
              sourceType: c.v.need.sourceType,
              sourceId: c.v.need.sourceId,
              kind: c.kind,
              description: c.v.need.description,
              unit: c.v.need.unit,
              calculatedQty: c.v.need.calculatedQty,
              purchaseQty: c.v.finalQty,
              quotedPrice: c.v.quotedPrice,
              quotedCurrency: c.v.currency,
              usdRateRub: c.v.currency === 'USD' ? usdRateRub : null,
              lineTotalOriginal: c.lineTotalOriginal,
              lineTotalRub: c.lineTotalRub,
              supplierNameSnapshot: c.supplierNameSnapshot,
              purchaseItemNameSnapshot: c.purchaseItemNameSnapshot,
            })),
          },
        },
        include: {
          lines: { orderBy: { createdAt: 'asc' } },
          completedBy: { select: { id: true, fullName: true } },
          revokedBy: { select: { id: true, fullName: true } },
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.CALCULATION_DONE,
          costEstimateTotalRub: estimate.totalCostRub,
          costEstimateCompletedAt: estimate.completedAt,
          costEstimateVersion: estimate.version,
        },
      });

      await this.audit.log(
        {
          event: 'ORDER_COST_ESTIMATE_CREATED',
          entityType: 'ORDER_COST_ESTIMATE',
          entityId: estimate.id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId,
            version: estimate.version,
            totalCostRub: estimate.totalCostRub.toString(),
            usdRateRub: estimate.usdRateRub
              ? estimate.usdRateRub.toString()
              : null,
            linesCount: computed.length,
          },
        },
        tx,
      );

      await this.audit.log(
        {
          event: 'ORDER_CALCULATION_COMPLETED',
          entityType: 'ORDER',
          entityId: orderId,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId,
            previousStatus: OrderStatus.CALCULATION,
            nextStatus: OrderStatus.CALCULATION_DONE,
            costEstimateId: estimate.id,
            version: estimate.version,
            totalCostRub: estimate.totalCostRub.toString(),
          },
        },
        tx,
      );

      return estimate;
    });

    this.logger.log(
      `event=order.calculation.completed orderId=${orderId} estimateId=${result.id} ` +
        `version=${result.version} totalCostRub=${result.totalCostRub.toString()} ` +
        `lines=${computed.length}`,
    );

    return this.toEstimateDto(result);
  }

  /**
   * Вернуть заказ на пересчёт: помечает активный
   * `OrderCostEstimate` как `REVOKED`, чистит snapshot-поля заказа,
   * возвращает статус в `CALCULATION`. `WorkshopNeed`,
   * `PurchaseOrder`, `PurchaseReceipt` не трогаем — закупщик
   * редактирует существующие строки заново.
   *
   * MVP-ограничение: разрешено только из `CALCULATION_DONE`. Из
   * `IN_PRODUCTION` reopen сознательно запрещён — production data
   * (паспорта / приёмки / зарплата) уже зависит от текущей
   * себестоимости.
   */
  async reopenCalculation(
    orderId: string,
    dto: ReopenOrderCalculationDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderCostEstimateDto | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (order.status !== OrderStatus.CALCULATION_DONE) {
      throw new OrderCalculationInvalidStatusException(
        `Вернуть на пересчёт можно только заказ в статусе «Расчёт завершён» (текущий: ${order.status}).`,
      );
    }

    const active = await this.prisma.orderCostEstimate.findFirst({
      where: { orderId, status: 'COMPLETED' },
      orderBy: { version: 'desc' },
    });

    const result = await this.prisma.$transaction(async (tx) => {
      let revoked: Awaited<
        ReturnType<typeof this.prisma.orderCostEstimate.findUnique>
      > | null = null;
      if (active) {
        revoked = await tx.orderCostEstimate.update({
          where: { id: active.id },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            revokedById: actorEmployeeId ?? null,
            comment:
              dto.reason && dto.reason.trim() !== ''
                ? dto.reason
                : active.comment,
          },
        });
      }
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.CALCULATION,
          costEstimateTotalRub: null,
          costEstimateCompletedAt: null,
          costEstimateVersion: null,
        },
      });

      await this.audit.log(
        {
          event: 'ORDER_CALCULATION_REOPENED',
          entityType: 'ORDER',
          entityId: orderId,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId,
            previousStatus: OrderStatus.CALCULATION_DONE,
            nextStatus: OrderStatus.CALCULATION,
            revokedEstimateId: revoked?.id ?? null,
            revokedVersion: revoked?.version ?? null,
            reason: dto.reason ?? null,
          },
        },
        tx,
      );

      return revoked;
    });

    this.logger.log(
      `event=order.calculation.reopened orderId=${orderId} ` +
        `revokedEstimateId=${result?.id ?? '<none>'}`,
    );

    if (!result) return null;
    const full = await this.prisma.orderCostEstimate.findUnique({
      where: { id: result.id },
      include: {
        lines: { orderBy: { createdAt: 'asc' } },
        completedBy: { select: { id: true, fullName: true } },
        revokedBy: { select: { id: true, fullName: true } },
      },
    });
    return full ? this.toEstimateDto(full) : null;
  }

  /**
   * Прочитать активный (status = COMPLETED) расчёт заказа. Используется
   * `OrdersService.toDetailDto`, чтобы заполнить
   * `OrderDetailDto.currentCostEstimate`. Возвращает `null` для
   * заказов без активного расчёта (DRAFT/CALCULATION или после reopen).
   */
  async getActiveEstimateForOrder(
    orderId: string,
  ): Promise<OrderCostEstimateDto | null> {
    const row = await this.prisma.orderCostEstimate.findFirst({
      where: { orderId, status: 'COMPLETED' },
      orderBy: { version: 'desc' },
      include: {
        lines: { orderBy: { createdAt: 'asc' } },
        completedBy: { select: { id: true, fullName: true } },
        revokedBy: { select: { id: true, fullName: true } },
      },
    });
    return row ? this.toEstimateDto(row) : null;
  }

  // -------------------------------------------------------------------------
  // Mappers
  // -------------------------------------------------------------------------

  private toEstimateDto(
    row: EstimateWithLines,
  ): OrderCostEstimateDto {
    return {
      id: row.id,
      orderId: row.orderId,
      version: row.version,
      status: row.status as OrderCostEstimateStatus,
      totalCostRub: row.totalCostRub.toString(),
      usdRateRub: row.usdRateRub ? row.usdRateRub.toString() : null,
      completedAt: row.completedAt.toISOString(),
      completedById: row.completedById,
      completedByName: row.completedBy?.fullName ?? null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedById: row.revokedById,
      revokedByName: row.revokedBy?.fullName ?? null,
      comment: row.comment,
      lines: row.lines.map((l) => this.toLineDto(l)),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toLineDto(row: EstimateLine): OrderCostEstimateLineDto {
    return {
      id: row.id,
      estimateId: row.estimateId,
      workshopNeedId: row.workshopNeedId,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      kind: row.kind,
      description: row.description,
      unit: row.unit,
      calculatedQty: row.calculatedQty ? row.calculatedQty.toString() : null,
      purchaseQty: row.purchaseQty.toString(),
      quotedPrice: row.quotedPrice.toString(),
      quotedCurrency: row.quotedCurrency,
      usdRateRub: row.usdRateRub ? row.usdRateRub.toString() : null,
      lineTotalOriginal: row.lineTotalOriginal.toString(),
      lineTotalRub: row.lineTotalRub.toString(),
      supplierNameSnapshot: row.supplierNameSnapshot,
      purchaseItemNameSnapshot: row.purchaseItemNameSnapshot,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

// Helper: keeps `_KIND_LABELS` referenced so that TS/treeshake don't
// complain when downstream UI imports the same module.
void ORDER_COST_ESTIMATE_LINE_KIND_LABELS;

type EstimateWithLines = Prisma.OrderCostEstimateGetPayload<{
  include: {
    lines: true;
    completedBy: { select: { id: true; fullName: true } };
    revokedBy: { select: { id: true; fullName: true } };
  };
}>;
type EstimateLine = Prisma.OrderCostEstimateLineGetPayload<true>;
