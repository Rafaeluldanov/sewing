import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  MaterialPlanSource,
  OrderActualMaterialsReportDto,
  OrderActualMaterialsRowDto,
} from '@sewing/shared/order-actual-materials';

import { PrismaService } from '../../prisma/prisma.service.js';
import { ACTIVE_CALCULATION_NEED_WHERE } from '../workshop-needs/workshop-need-scope.js';

/** Материальные `sourceType` потребности цеха (для fallback-плана). */
const MATERIAL_NEED_SOURCE_TYPES = new Set([
  'TECH_CARD_MATERIAL_LINE',
  'ORDER_MATERIAL_REQUIREMENT',
  'PATTERN_PARAMETER_NORM',
]);

/**
 * Себестоимость, Фаза 2 (первый срез): отчёт «Материалы план → факт по
 * заказу».
 *
 * Read-модель поверх существующих данных (новых таблиц нет):
 *   - ПЛАН — активный `OrderCostEstimate` (строки kind MATERIAL/HARDWARE),
 *     fallback на RUB-строки `WorkshopNeed`, иначе нет плана;
 *   - ФАКТ — POSTED `PurchaseReceiptLine` (`receivedQty × priceSnapshot`),
 *     привязка к заказу через `receipt.customerOrderId` или
 *     `line.workshopNeed.orderId`.
 *
 * Себестоимость ПОТРЕБЛЯЕТ факт приёмок — проводок не пишет. Курс USD для
 * факта берётся из активной сметы заказа (если нет — USD-строки факта не
 * учитываются с флагом `USD_NO_RATE`).
 */
@Injectable()
export class OrderActualMaterialsService {
  constructor(private readonly prisma: PrismaService) {}

  private okr1c(v: Prisma.Decimal): Prisma.Decimal {
    return v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  async getReport(): Promise<OrderActualMaterialsReportDto> {
    // 1. Факт: POSTED-строки приёмок (приёмка тоже POSTED) с привязкой к заказу.
    const receiptLines = await this.prisma.purchaseReceiptLine.findMany({
      where: { status: 'POSTED', purchaseReceipt: { status: 'POSTED' } },
      select: {
        id: true,
        receivedQty: true,
        priceSnapshot: true,
        currencySnapshot: true,
        purchaseReceipt: { select: { customerOrderId: true } },
        workshopNeed: { select: { orderId: true } },
      },
    });

    type RLine = (typeof receiptLines)[number];
    const linesByOrder = new Map<string, RLine[]>();
    for (const l of receiptLines) {
      const orderId =
        l.purchaseReceipt.customerOrderId ?? l.workshopNeed?.orderId ?? null;
      if (!orderId) continue; // приёмка не привязана к заказу — пропускаем
      const arr = linesByOrder.get(orderId) ?? [];
      arr.push(l);
      linesByOrder.set(orderId, arr);
    }

    const orderIds = [...linesByOrder.keys()];
    if (orderIds.length === 0) {
      return {
        rows: [],
        totalPlanRub: '0.00',
        totalFactRub: '0.00',
        totalVarianceRub: '0.00',
        totalPlanLaborRub: '0.00',
        totalFactLaborRub: '0.00',
        totalPlanDirectRub: '0.00',
        totalFactDirectRub: '0.00',
        totalVarianceDirectRub: '0.00',
        totalOverheadRub: '0.00',
        totalFullCostFactRub: '0.00',
      };
    }

    // 2. Номера заказов.
    const orders = await this.prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, number: true, operationCostPlanRub: true },
    });
    const orderById = new Map(orders.map((o) => [o.id, o]));

    // 2b. Факт труда — Σ APPROVED `OperationEntry` по заказу (через паспорт).
    const opEntries = await this.prisma.operationEntry.findMany({
      where: {
        status: 'APPROVED',
        passport: { orderId: { in: orderIds } },
      },
      select: { amount: true, passport: { select: { orderId: true } } },
    });
    const factLaborByOrder = new Map<string, Prisma.Decimal>();
    for (const e of opEntries) {
      const oid = e.passport.orderId;
      if (!oid) continue;
      factLaborByOrder.set(
        oid,
        (factLaborByOrder.get(oid) ?? new Prisma.Decimal(0)).add(e.amount),
      );
    }

    // 3. Активные сметы (latest COMPLETED) — план + курс USD для факта.
    const estimates = await this.prisma.orderCostEstimate.findMany({
      where: { orderId: { in: orderIds }, status: 'COMPLETED' },
      orderBy: { version: 'desc' },
      select: {
        orderId: true,
        usdRateRub: true,
        lines: { select: { kind: true, lineTotalRub: true } },
      },
    });
    const estimateByOrder = new Map<string, (typeof estimates)[number]>();
    for (const est of estimates) {
      if (!estimateByOrder.has(est.orderId)) estimateByOrder.set(est.orderId, est);
    }

    // 4. Fallback-план из потребности цеха (для заказов без сметы).
    const ordersNoEstimate = orderIds.filter((id) => !estimateByOrder.has(id));
    const needs = ordersNoEstimate.length
      ? await this.prisma.workshopNeed.findMany({
          where: {
            orderId: { in: ordersNoEstimate },
            NOT: { status: 'CANCELLED' },
            // Фича «Варианты просчёта»: fallback-план без сметы — только
            // активный вариант, иначе двойной счёт.
            AND: [ACTIVE_CALCULATION_NEED_WHERE],
          },
          select: {
            orderId: true,
            sourceType: true,
            purchaseQty: true,
            calculatedQty: true,
            quotedPrice: true,
            quotedCurrency: true,
          },
        })
      : [];
    type WNeed = (typeof needs)[number];
    const needsByOrder = new Map<string, WNeed[]>();
    for (const wn of needs) {
      const arr = needsByOrder.get(wn.orderId) ?? [];
      arr.push(wn);
      needsByOrder.set(wn.orderId, arr);
    }

    // 5. Считаем строки отчёта.
    const rows: OrderActualMaterialsRowDto[] = [];
    // Прямая с/с (Decimal) по каждой строке — база распределения накладных.
    const directList: { row: OrderActualMaterialsRowDto; fd: Prisma.Decimal }[] =
      [];
    let totalPlan = new Prisma.Decimal(0);
    let totalFact = new Prisma.Decimal(0);
    let totalPlanLabor = new Prisma.Decimal(0);
    let totalFactLabor = new Prisma.Decimal(0);

    for (const orderId of orderIds) {
      const warnings = new Set<string>();
      const est = estimateByOrder.get(orderId);

      // --- ПЛАН ---
      let plan = new Prisma.Decimal(0);
      let planSource: MaterialPlanSource = 'NONE';
      if (est) {
        planSource = 'COST_ESTIMATE';
        for (const ln of est.lines) {
          if (ln.kind === 'MATERIAL' || ln.kind === 'HARDWARE') {
            plan = plan.add(ln.lineTotalRub);
          }
        }
      } else {
        const wns = needsByOrder.get(orderId) ?? [];
        const material = wns.filter((wn) =>
          MATERIAL_NEED_SOURCE_TYPES.has(wn.sourceType ?? ''),
        );
        if (material.length > 0) {
          planSource = 'WORKSHOP_NEED';
          for (const wn of material) {
            const qty = wn.purchaseQty ?? wn.calculatedQty;
            const price = wn.quotedPrice;
            if (qty == null || price == null) continue;
            if ((wn.quotedCurrency ?? 'RUB') !== 'RUB') {
              warnings.add('PLAN_USD_SKIPPED');
              continue;
            }
            plan = plan.add(new Prisma.Decimal(qty).mul(price));
          }
        }
      }

      // --- ФАКТ ---
      let fact = new Prisma.Decimal(0);
      const lines = linesByOrder.get(orderId) ?? [];
      let countedLines = 0;
      for (const l of lines) {
        if (l.priceSnapshot == null) {
          warnings.add('NO_PRICE');
          continue;
        }
        const currency = l.currencySnapshot ?? 'RUB';
        const base = new Prisma.Decimal(l.receivedQty).mul(l.priceSnapshot);
        if (currency === 'RUB') {
          fact = fact.add(base);
          countedLines += 1;
        } else {
          // USD-факт: курс берём из активной сметы заказа
          if (est?.usdRateRub == null) {
            warnings.add('USD_NO_RATE');
            continue;
          }
          fact = fact.add(base.mul(est.usdRateRub));
          countedLines += 1;
        }
      }

      plan = this.okr1c(plan);
      fact = this.okr1c(fact);
      const variance = this.okr1c(fact.sub(plan));

      // --- ТРУД (Срез 2) ---
      const order = orderById.get(orderId);
      const planLabor = this.okr1c(
        new Prisma.Decimal(order?.operationCostPlanRub ?? 0),
      );
      const factLabor = this.okr1c(
        factLaborByOrder.get(orderId) ?? new Prisma.Decimal(0),
      );
      const varianceLabor = this.okr1c(factLabor.sub(planLabor));

      // --- ПРЯМАЯ СЕБЕСТОИМОСТЬ (материалы + труд) ---
      const planDirect = this.okr1c(plan.add(planLabor));
      const factDirect = this.okr1c(fact.add(factLabor));
      const varianceDirect = this.okr1c(factDirect.sub(planDirect));

      totalPlan = totalPlan.add(plan);
      totalFact = totalFact.add(fact);
      totalPlanLabor = totalPlanLabor.add(planLabor);
      totalFactLabor = totalFactLabor.add(factLabor);

      const row: OrderActualMaterialsRowDto = {
        orderId,
        orderNumber: orderById.get(orderId)?.number ?? orderId,
        planMaterialsRub: plan.toFixed(2),
        planSource,
        factMaterialsRub: fact.toFixed(2),
        varianceRub: variance.toFixed(2),
        receiptLinesCount: countedLines,
        planLaborRub: planLabor.toFixed(2),
        factLaborRub: factLabor.toFixed(2),
        varianceLaborRub: varianceLabor.toFixed(2),
        planDirectRub: planDirect.toFixed(2),
        factDirectRub: factDirect.toFixed(2),
        varianceDirectRub: varianceDirect.toFixed(2),
        overheadRub: '0.00',
        fullCostFactRub: factDirect.toFixed(2),
        warnings: [...warnings],
      };
      rows.push(row);
      directList.push({ row, fd: factDirect });
    }

    // 6. Накладные (Срез 3): пул OUT-проводок по статьям isOverhead (нетто
    // сторно) распределяем на заказы пропорционально прямой с/с.
    // TODO: период-версия (распределение по месяцам) — будущее уточнение.
    const overheadEntries = await this.prisma.cashFlowEntry.findMany({
      where: { item: { isOverhead: true } },
      select: { direction: true, amount: true },
    });
    let pool = new Prisma.Decimal(0);
    for (const e of overheadEntries) {
      // OUT = расход (+), сторно OUT приходит как IN (−) — нетто.
      pool =
        e.direction === 'OUT' ? pool.add(e.amount) : pool.sub(e.amount);
    }
    if (pool.lessThan(0)) pool = new Prisma.Decimal(0);
    pool = this.okr1c(pool);

    let totalOverhead = new Prisma.Decimal(0);
    const base = directList.reduce(
      (acc, d) => acc.add(d.fd),
      new Prisma.Decimal(0),
    );
    if (pool.greaterThan(0) && base.greaterThan(0)) {
      const positive = directList.filter((d) => d.fd.greaterThan(0));
      let allocated = new Prisma.Decimal(0);
      positive.forEach((d, i) => {
        let share: Prisma.Decimal;
        if (i === positive.length - 1) {
          // последнему — остаток, чтобы Σ == pool (INV-11)
          share = pool.sub(allocated);
        } else {
          share = this.okr1c(pool.mul(d.fd).div(base));
          allocated = allocated.add(share);
        }
        d.row.overheadRub = share.toFixed(2);
        d.row.fullCostFactRub = this.okr1c(d.fd.add(share)).toFixed(2);
        totalOverhead = totalOverhead.add(share);
      });
    }

    // Сортировка: крупнейший перерасход прямой с/с (↓), затем номер.
    rows.sort((a, b) => {
      const va = Number(b.varianceDirectRub) - Number(a.varianceDirectRub);
      if (va !== 0) return va;
      return a.orderNumber.localeCompare(b.orderNumber);
    });

    totalPlan = this.okr1c(totalPlan);
    totalFact = this.okr1c(totalFact);
    totalPlanLabor = this.okr1c(totalPlanLabor);
    totalFactLabor = this.okr1c(totalFactLabor);
    const totalPlanDirect = this.okr1c(totalPlan.add(totalPlanLabor));
    const totalFactDirect = this.okr1c(totalFact.add(totalFactLabor));
    totalOverhead = this.okr1c(totalOverhead);

    return {
      rows,
      totalPlanRub: totalPlan.toFixed(2),
      totalFactRub: totalFact.toFixed(2),
      totalVarianceRub: this.okr1c(totalFact.sub(totalPlan)).toFixed(2),
      totalPlanLaborRub: totalPlanLabor.toFixed(2),
      totalFactLaborRub: totalFactLabor.toFixed(2),
      totalPlanDirectRub: totalPlanDirect.toFixed(2),
      totalFactDirectRub: totalFactDirect.toFixed(2),
      totalVarianceDirectRub: this.okr1c(
        totalFactDirect.sub(totalPlanDirect),
      ).toFixed(2),
      totalOverheadRub: totalOverhead.toFixed(2),
      totalFullCostFactRub: this.okr1c(
        totalFactDirect.add(totalOverhead),
      ).toFixed(2),
    };
  }
}
