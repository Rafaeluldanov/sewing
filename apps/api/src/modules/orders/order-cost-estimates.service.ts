import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma, type Order } from '@prisma/client';
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
import { ORDER_EXTRA_COST_SOURCE_TYPE } from '@sewing/shared/order-extra-costs';
import {
  OrderCalculationIncompleteException,
  OrderCalculationInvalidStatusException,
  OrderCalculationUsdRateRequiredException,
} from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TIRAGE_NEED_WHERE } from '../workshop-needs/workshop-need-scope.js';

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
   * Единый билдер строк сметы — общий для `completeCalculation` и
   * `recalculateCostEstimate`. Собирает строки из:
   *   - активных `WorkshopNeed` (исключая CANCELLED) — материалы /
   *     фурнитура / нанесение, с валидацией «К закупке» / цены / валюты;
   *   - `OrderExtraCost` с `includeInCostPrice = true` — прочие /
   *     непредвиденные расходы (kind=OTHER, sourceType=EXTRA_COST);
   *   - стоимости разработки лекала (`patternDevelopmentCostRub`).
   *
   * Курс USD (`usdRateInput`) обязателен, если хотя бы одна строка
   * (потребность ИЛИ прочий расход) в USD. `materialsAndHardwareCostPolicy
   * = EXCLUDE` исключает строки MATERIAL/HARDWARE из итога (но не из
   * самих строк); прочие расходы и разработка лекала — услуги компании,
   * в итог входят всегда.
   *
   * Бросает `OrderCalculationIncompleteException` /
   * `OrderCalculationUsdRateRequiredException` до изменения данных.
   */
  private async assembleEstimatePlan(
    order: Order,
    usdRateInput: string | null | undefined,
  ): Promise<{
    lineCreates: Prisma.OrderCostEstimateLineUncheckedCreateWithoutEstimateInput[];
    totalCostRub: Prisma.Decimal;
    usdRateRub: Prisma.Decimal | null;
    linesCount: number;
    includeDevelopmentLine: boolean;
    developmentCost: Prisma.Decimal | null;
    extraCostsCount: number;
  }> {
    const orderId = order.id;

    // Берём ВСЕ строки потребности (исключая CANCELLED) — это «активные»
    // потребности заказа. Стабильная сортировка по createdAt+id.
    // Фича «Варианты просчёта»: только строки АКТИВНОГО варианта —
    // иначе смета суммирует материалы всех вариантов сравнения
    // (двойной счёт). Сравнение смет вариантов — через переключение
    // вкладки + completeCalculation по каждому.
    const needs = await this.prisma.workshopNeed.findMany({
      where: {
        orderId,
        NOT: { status: 'CANCELLED' },
        AND: [TIRAGE_NEED_WHERE],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        selectedSupplier: { select: { id: true, name: true } },
        selectedSupplierCatalogItem: { select: { id: true, name: true } },
      },
    });

    // Прочие / непредвиденные расходы, помеченные «в себестоимость».
    const extraCosts = await this.prisma.orderExtraCost.findMany({
      where: { orderId, includeInCostPrice: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

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
      const MAX_LISTED = 5;
      const listed = errors
        .slice(0, MAX_LISTED)
        .map((e) => `«${e.description || 'без названия'}» — ${e.reason}`)
        .join('; ');
      const rest =
        errors.length > MAX_LISTED ? ` и ещё ${errors.length - MAX_LISTED}` : '';
      const head =
        errors.length === 1
          ? 'Нельзя сохранить расчёт — заполните данные по строке: '
          : `Нельзя сохранить расчёт — заполните данные по ${errors.length} строкам: `;
      throw new OrderCalculationIncompleteException(
        `${head}${listed}${rest}.`,
        errors,
      );
    }

    // Прочие расходы в USD тоже требуют курса.
    for (const e of extraCosts) {
      if ((e.currency ?? '').toUpperCase() === 'USD') hasUsd = true;
    }

    // Курс USD: обязателен, если есть USD-строки. На MVP только USD→RUB.
    let usdRateRub: Prisma.Decimal | null = null;
    if (hasUsd) {
      if (!usdRateInput) {
        throw new OrderCalculationUsdRateRequiredException();
      }
      usdRateRub = new Prisma.Decimal(usdRateInput);
      if (!usdRateRub.greaterThan(0)) {
        throw new OrderCalculationUsdRateRequiredException();
      }
    }

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
        materialRole: v.need.materialRole,
      });
      const supplierNameSnapshot =
        v.need.selectedSupplier?.name ?? v.need.supplierNameText ?? null;
      const purchaseItemNameSnapshot =
        v.need.selectedSupplierCatalogItem?.name ??
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

    // Давальческое сырьё / фурнитура клиента: при политике EXCLUDE
    // строки MATERIAL/HARDWARE не входят в итог (см.
    // `Order.materialsAndHardwareCostPolicy`).
    const isMaterialsAndHardwareExcluded =
      (order.materialsAndHardwareCostPolicy ?? 'INCLUDE') === 'EXCLUDE';
    let linesTotalRub = computed.reduce((acc, c) => {
      if (
        isMaterialsAndHardwareExcluded &&
        (c.kind === 'MATERIAL' || c.kind === 'HARDWARE')
      ) {
        return acc;
      }
      return acc.add(c.lineTotalRub);
    }, new Prisma.Decimal(0));

    const needLineCreates: Prisma.OrderCostEstimateLineUncheckedCreateWithoutEstimateInput[] =
      computed.map((c) => ({
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
      }));

    // Прочие / непредвиденные расходы (kind=OTHER, sourceType=EXTRA_COST).
    // В итог входят всегда (это услуги/затраты компании, не давальческое
    // сырьё). USD конвертируется по тому же курсу.
    const extraCostLineCreates: Prisma.OrderCostEstimateLineUncheckedCreateWithoutEstimateInput[] =
      extraCosts.map((e) => {
        const amount = round2(new Prisma.Decimal(e.amount));
        const currency =
          (e.currency ?? 'RUB').toUpperCase() === 'USD' ? 'USD' : 'RUB';
        const lineTotalRub =
          currency === 'USD' && usdRateRub
            ? round2(amount.mul(usdRateRub))
            : amount;
        linesTotalRub = linesTotalRub.add(lineTotalRub);
        return {
          workshopNeedId: null,
          sourceType: ORDER_EXTRA_COST_SOURCE_TYPE,
          sourceId: e.id,
          kind: 'OTHER',
          description: e.description,
          unit: 'усл.',
          calculatedQty: null,
          purchaseQty: new Prisma.Decimal(1),
          quotedPrice: amount,
          quotedCurrency: currency,
          usdRateRub: currency === 'USD' ? usdRateRub : null,
          lineTotalOriginal: amount,
          lineTotalRub,
          supplierNameSnapshot: null,
          purchaseItemNameSnapshot: null,
        };
      });

    // Разработка лекала — отдельной строкой, если чекбокс «входит в
    // себестоимость» включён (см. `Order.patternDevelopmentCostInCostPrice`).
    const devCostRaw = order.patternDevelopmentCostRub;
    const developmentCost =
      order.patternDevelopmentCostInCostPrice && devCostRaw != null
        ? round2(new Prisma.Decimal(devCostRaw))
        : null;
    const includeDevelopmentLine =
      developmentCost != null && developmentCost.greaterThan(0);

    const developmentLineCreates: Prisma.OrderCostEstimateLineUncheckedCreateWithoutEstimateInput[] =
      includeDevelopmentLine
        ? [
            {
              workshopNeedId: null,
              sourceType: 'PATTERN_DEVELOPMENT',
              sourceId: order.patternItemId ?? null,
              kind: 'OTHER',
              description: 'Разработка лекала',
              unit: 'усл.',
              calculatedQty: null,
              purchaseQty: new Prisma.Decimal(1),
              quotedPrice: developmentCost!,
              quotedCurrency: 'RUB',
              usdRateRub: null,
              lineTotalOriginal: developmentCost!,
              lineTotalRub: developmentCost!,
              supplierNameSnapshot: null,
              purchaseItemNameSnapshot: null,
            },
          ]
        : [];

    const totalCostRub = round2(
      includeDevelopmentLine
        ? linesTotalRub.add(developmentCost!)
        : linesTotalRub,
    );

    const lineCreates = [
      ...needLineCreates,
      ...extraCostLineCreates,
      ...developmentLineCreates,
    ];

    return {
      lineCreates,
      totalCostRub,
      usdRateRub,
      linesCount: lineCreates.length,
      includeDevelopmentLine,
      developmentCost,
      extraCostsCount: extraCostLineCreates.length,
    };
  }

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

    // Сборка строк сметы (потребности + прочие расходы + разработка
    // лекала) — единый билдер, общий с `recalculateCostEstimate`.
    const plan = await this.assembleEstimatePlan(order, dto.usdRateRub);
    const {
      lineCreates,
      totalCostRub,
      usdRateRub,
      linesCount,
      includeDevelopmentLine,
      developmentCost,
    } = plan;

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
          totalCostRub,
          usdRateRub,
          completedById: actorEmployeeId ?? null,
          comment: dto.comment ?? null,
          lines: { create: lineCreates },
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
          // Смета собрана по актуальным строкам — отметка «себестоимость
          // устарела» (фича «Правка потребности на любой стадии») больше
          // не про что. Снимаем в той же tx, что и сумму.
          costEstimateStaleAt: null,
          costEstimateStaleReason: null,
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
            linesCount,
            patternDevelopmentCostRub: includeDevelopmentLine
              ? developmentCost!.toString()
              : null,
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
        `lines=${linesCount}`,
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
   * Пересчитать себестоимость БЕЗ смены статуса заказа (этап
   * «Корректировка материалов после просчёта»).
   *
   * В отличие от `reopen → complete`, этот метод не откатывает заказ в
   * `CALCULATION`: он помечает текущий `COMPLETED`-расчёт как `REVOKED`
   * и сразу создаёт новую `COMPLETED`-версию из актуальных
   * `WorkshopNeed` + `OrderExtraCost`. Нужен, чтобы учесть ручные
   * материалы и непредвиденные расходы, добавленные уже после фиксации
   * себестоимости — в том числе когда заказ в `IN_PRODUCTION` (reopen
   * там запрещён, т.к. от себестоимости зависят production-данные).
   *
   * Разрешён из `CALCULATION_DONE`, `IN_PRODUCTION` и `DONE` (фича
   * «Правка потребности на любой стадии»: ошибку в расчёте чинят и
   * после выпуска — себестоимость выпущенного заказа обязана сойтись с
   * тем, что реально ушло в изделие). Для заказа без активного расчёта
   * (например, в `CALCULATION`) — пользоваться `completeCalculation`.
   */
  async recalculateCostEstimate(
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
    if (
      order.status !== OrderStatus.CALCULATION_DONE &&
      order.status !== OrderStatus.IN_PRODUCTION &&
      order.status !== OrderStatus.DONE
    ) {
      throw new OrderCalculationInvalidStatusException(
        `Пересчитать себестоимость можно только для заказа в статусе «Расчёт завершён», «В производстве» или «Выпущен» (текущий: ${order.status}).`,
      );
    }

    const plan = await this.assembleEstimatePlan(order, dto.usdRateRub);

    const result = await this.prisma.$transaction(async (tx) => {
      // Отзываем текущий активный расчёт (если есть).
      const active = await tx.orderCostEstimate.findFirst({
        where: { orderId, status: 'COMPLETED' },
        orderBy: { version: 'desc' },
      });
      if (active) {
        await tx.orderCostEstimate.update({
          where: { id: active.id },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            revokedById: actorEmployeeId ?? null,
          },
        });
      }

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
          totalCostRub: plan.totalCostRub,
          usdRateRub: plan.usdRateRub,
          completedById: actorEmployeeId ?? null,
          comment: dto.comment ?? null,
          lines: { create: plan.lineCreates },
        },
        include: {
          lines: { orderBy: { createdAt: 'asc' } },
          completedBy: { select: { id: true, fullName: true } },
          revokedBy: { select: { id: true, fullName: true } },
        },
      });

      // Обновляем ТОЛЬКО snapshot-поля себестоимости — статус заказа
      // НЕ трогаем (заказ остаётся в CALCULATION_DONE / IN_PRODUCTION /
      // DONE). Отметку «себестоимость устарела» снимаем: строки сметы
      // только что пересобраны по актуальным потребностям.
      await tx.order.update({
        where: { id: orderId },
        data: {
          costEstimateTotalRub: estimate.totalCostRub,
          costEstimateCompletedAt: estimate.completedAt,
          costEstimateVersion: estimate.version,
          costEstimateStaleAt: null,
          costEstimateStaleReason: null,
        },
      });

      await this.audit.log(
        {
          event: 'ORDER_COST_ESTIMATE_RECALCULATED',
          entityType: 'ORDER_COST_ESTIMATE',
          entityId: estimate.id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId,
            orderStatus: order.status,
            revokedEstimateId: active?.id ?? null,
            revokedVersion: active?.version ?? null,
            version: estimate.version,
            totalCostRub: estimate.totalCostRub.toString(),
            linesCount: plan.linesCount,
            extraCostsCount: plan.extraCostsCount,
          },
        },
        tx,
      );

      return estimate;
    });

    this.logger.log(
      `event=order.cost_estimate.recalculated orderId=${orderId} ` +
        `estimateId=${result.id} version=${result.version} ` +
        `totalCostRub=${result.totalCostRub.toString()} lines=${plan.linesCount}`,
    );

    return this.toEstimateDto(result);
  }

  /**
   * Автопересчёт себестоимости после правки материалов заказа (фича
   * «Правка потребности на любой стадии»).
   *
   * Зовётся из `WorkshopNeedsService` сразу после того, как строка
   * потребности изменилась (правка / ручное добавление / удаление /
   * отмена). Требование владельца: «после изменения у нас должна
   * пересчитаться себестоимость за изделие» — без второго клика.
   *
   * Best-effort по устройству: пересчёт может быть объективно невозможен
   * (в строках USD, а курса нет; у строки нет «К закупке» или цены;
   * сметы ещё нет — заказ в `CALCULATION`). Молча оставлять старую сумму
   * нельзя: «₽ за изделие» уже не соответствует материалам. Поэтому
   * отказ становится ВИДИМЫМ — `Order.costEstimateStaleAt` + причина,
   * которую вкладка «Потребности» рисует плашкой с кнопкой
   * «Пересчитать» (там же вводится курс USD).
   *
   * Курс USD берём из отзываемой сметы: пересчёт «по тому же курсу, что
   * и в прошлый раз» — единственное решение, которое можно принять без
   * человека. Нет курса и появились USD-строки → плашка.
   *
   * Никогда не бросает: правка потребности не должна отваливаться из-за
   * сметы.
   */
  async syncAfterNeedsChange(
    orderId: string,
    actorEmployeeId?: string | null,
  ): Promise<{ recalculated: boolean; staleReason: string | null }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return { recalculated: false, staleReason: null };

    const active = await this.prisma.orderCostEstimate.findFirst({
      where: { orderId, status: 'COMPLETED' },
      orderBy: { version: 'desc' },
      include: { lines: { orderBy: { createdAt: 'asc' } } },
    });

    // Сметы нет — пересчитывать нечего. Это норма для `CALCULATION`:
    // сводка себестоимости там считается «живьём» по строкам
    // потребности, и правка видна сразу, без версий сметы.
    if (!active) {
      await this.clearStale(orderId);
      return { recalculated: false, staleReason: null };
    }

    if (
      order.status !== OrderStatus.CALCULATION_DONE &&
      order.status !== OrderStatus.IN_PRODUCTION &&
      order.status !== OrderStatus.DONE
    ) {
      const reason = `Себестоимость не пересчитана автоматически: статус заказа «${order.status}» не допускает пересчёт сметы.`;
      await this.markStale(orderId, reason);
      return { recalculated: false, staleReason: reason };
    }

    const usdRateRub = active.usdRateRub ? active.usdRateRub.toString() : null;
    try {
      // Сначала собираем план и сверяем со сметой: правка могла не
      // затронуть деньги (закупщик сохранил строку, поменяв только
      // статус или комментарий). Плодить версию сметы на такое нельзя —
      // история расчётов должна читаться как «что реально менялось».
      const plan = await this.assembleEstimatePlan(order, usdRateRub);
      if (samePlanAsEstimate(plan.lineCreates, plan.totalCostRub, active)) {
        await this.clearStale(orderId);
        return { recalculated: false, staleReason: null };
      }

      await this.recalculateCostEstimate(
        orderId,
        {
          usdRateRub,
          comment: 'Автопересчёт после правки потребности',
        },
        actorEmployeeId,
      );
      return { recalculated: true, staleReason: null };
    } catch (e) {
      // Ожидаемые отказы: нет курса USD (`..._USD_RATE_REQUIRED`) и
      // неполные строки (`..._INCOMPLETE` — нет «К закупке» / цены).
      // Оба чинятся человеком, поэтому текст исключения и есть текст
      // плашки. Неожиданные ошибки тоже не роняют правку — они уходят
      // в лог и в ту же плашку общим текстом.
      const reason =
        e instanceof OrderCalculationUsdRateRequiredException ||
        e instanceof OrderCalculationIncompleteException
          ? (e.message ?? 'Себестоимость не пересчитана.')
          : 'Себестоимость не пересчитана автоматически — пересчитайте вручную.';
      this.logger.warn(
        `event=order.cost_estimate.autosync_failed orderId=${orderId} ` +
          `reason=${e instanceof Error ? e.message : String(e)}`,
      );
      await this.markStale(orderId, reason);
      return { recalculated: false, staleReason: reason };
    }
  }

  /** Поставить отметку «себестоимость устарела» (best-effort). */
  private async markStale(orderId: string, reason: string): Promise<void> {
    try {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { costEstimateStaleAt: new Date(), costEstimateStaleReason: reason },
      });
    } catch {
      // Заказ мог исчезнуть между чтением и записью — не роняем правку.
    }
  }

  /** Снять отметку «себестоимость устарела» (best-effort). */
  private async clearStale(orderId: string): Promise<void> {
    try {
      await this.prisma.order.updateMany({
        where: { id: orderId, costEstimateStaleAt: { not: null } },
        data: { costEstimateStaleAt: null, costEstimateStaleReason: null },
      });
    } catch {
      // См. `markStale`.
    }
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

/**
 * Совпадает ли только что собранный план сметы с уже зафиксированной
 * версией (фича «Правка потребности на любой стадии»,
 * `syncAfterNeedsChange`).
 *
 * Нужно, чтобы автопересчёт не плодил версии на правках, которые денег
 * не касаются: закупщик сохранил строку, поменяв статус или
 * комментарий, — сумма и состав сметы те же, новая версия только
 * замусорит историю.
 *
 * Сравниваем итог и построчную подпись (что именно, сколько, почём) —
 * `id`/`createdAt` в подпись не входят, они у новых строк всегда другие.
 */
function samePlanAsEstimate(
  lineCreates: Prisma.OrderCostEstimateLineUncheckedCreateWithoutEstimateInput[],
  totalCostRub: Prisma.Decimal,
  active: { totalCostRub: Prisma.Decimal; lines: EstimateLine[] },
): boolean {
  if (!totalCostRub.equals(active.totalCostRub)) return false;
  if (lineCreates.length !== active.lines.length) return false;

  const planKeys = lineCreates.map((l) =>
    [
      l.workshopNeedId ?? '',
      l.sourceType ?? '',
      l.sourceId ?? '',
      l.kind ?? '',
      l.description ?? '',
      l.unit ?? '',
      String(l.purchaseQty ?? ''),
      String(l.quotedPrice ?? ''),
      l.quotedCurrency ?? '',
      String(l.lineTotalRub ?? ''),
    ].join('|'),
  );
  const activeKeys = active.lines.map((l) =>
    [
      l.workshopNeedId ?? '',
      l.sourceType ?? '',
      l.sourceId ?? '',
      l.kind ?? '',
      l.description ?? '',
      l.unit ?? '',
      l.purchaseQty.toString(),
      l.quotedPrice.toString(),
      l.quotedCurrency ?? '',
      l.lineTotalRub.toString(),
    ].join('|'),
  );
  planKeys.sort();
  activeKeys.sort();
  return planKeys.every((k, i) => k === activeKeys[i]);
}

type EstimateWithLines = Prisma.OrderCostEstimateGetPayload<{
  include: {
    lines: true;
    completedBy: { select: { id: true; fullName: true } };
    revokedBy: { select: { id: true; fullName: true } };
  };
}>;
type EstimateLine = Prisma.OrderCostEstimateLineGetPayload<true>;
