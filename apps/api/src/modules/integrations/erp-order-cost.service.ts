import { Injectable, Logger } from '@nestjs/common';
import { EntryStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import { PassportRealCostService } from '../costs/passport-real-cost.service.js';
import { erpMaterialCostByPassport } from '../costs/erp-material-fact.js';

const POSTED = 'POSTED';

const num = (value: Prisma.Decimal | number | null | undefined): number =>
  value == null ? 0 : Number(value);
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export type OrderFactCost = {
  materials_own_rub: number;
  materials_erp_rub: number;
  piecework_rub: number;
  salary_rub: number;
  other_rub: number;
  total_rub: number;
  per_unit_rub: number;
  plan_total_rub: number | null;
  plan_per_unit_rub: number | null;
  warnings: string[];
};

/**
 * Фактическая себестоимость СДАННОГО заказа — по документу производства, а не по паспорту.
 *
 * ⛔ Компоненты отдаются РАЗДЕЛЬНО (свой материал, материал ERP, сдельная, разнесённый оклад,
 * прочие расходы) и все сразу. Что из них считать себестоимостью заказа — решение владельца, и
 * оно должно приниматься на живых числах, а не задним числом по потерянным данным: собрать
 * компонент, которого не собрали, потом будет уже нечем.
 *
 * Источники не пересекаются: свои материалы цеха (`MaterialIssue` нетто возвратов) и материалы,
 * списанные ERP по выпуску (у цеха своего документа расхода на них нет).
 */
@Injectable()
export class ErpOrderCostService {
  private readonly logger = new Logger(ErpOrderCostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passportCost: PassportRealCostService,
  ) {}

  async factCostForOrder(
    orderId: string,
    passportIds: string[],
    qtyGood: number,
  ): Promise<OrderFactCost> {
    const warnings: string[] = [];
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        materialsAndHardwareCostPolicy: true,
        patternDevelopmentCostRub: true,
        patternDevelopmentCostInCostPrice: true,
        inProductionAt: true,
        completedAt: true,
        costEstimateTotalRub: true,
        items: { select: { qtyPlan: true } },
      },
    });
    if (!order) {
      return {
        materials_own_rub: 0, materials_erp_rub: 0, piecework_rub: 0, salary_rub: 0,
        other_rub: 0, total_rub: 0, per_unit_rub: 0,
        plan_total_rub: null, plan_per_unit_rub: null,
        warnings: ['ORDER_NOT_FOUND'],
      };
    }
    const excluded = order.materialsAndHardwareCostPolicy === 'EXCLUDE';

    const [issues, returns, piecework, extras] = await Promise.all([
      this.prisma.materialIssue.aggregate({
        where: { status: POSTED, passportId: { in: passportIds } },
        _sum: { totalCost: true },
      }),
      this.prisma.materialIssueReturn.aggregate({
        where: { status: POSTED, passportId: { in: passportIds } },
        _sum: { totalCost: true },
      }),
      this.prisma.operationEntry.aggregate({
        where: { passportId: { in: passportIds }, status: EntryStatus.APPROVED },
        _sum: { amount: true },
      }),
      this.prisma.orderExtraCost.aggregate({
        where: { orderId, includeInCostPrice: true },
        _sum: { amount: true },
      }),
    ]);
    const erpByPassport = await erpMaterialCostByPassport(this.prisma, passportIds);
    let materialsErp = 0;
    for (const value of erpByPassport.values()) materialsErp += num(value);

    const materialsOwn = excluded
      ? 0
      : num(issues._sum.totalCost) - num(returns._sum.totalCost);
    if (excluded) warnings.push('MATERIALS_EXCLUDED_BY_POLICY');
    if (!excluded && materialsOwn === 0 && materialsErp === 0) {
      warnings.push('NO_MATERIAL_FACT');
    }

    // Разнесённый оклад: считаем ПО ОКНУ ПРОИЗВОДСТВА заказа и берём только его паспорта.
    // ⛔ Отдельной строкой, а не внутри сдельной: у цеха оклад — почти половина денег труда,
    // и владелец решает, входит ли он в себестоимость заказа.
    let salary = 0;
    const from = order.inProductionAt ?? null;
    const to = order.completedAt ?? new Date();
    if (from && passportIds.length > 0) {
      try {
        const { rubByPassport } = await this.passportCost.apportionedSalaryForPeriod(from, to);
        for (const pid of passportIds) salary += rubByPassport.get(pid) ?? 0;
      } catch (error) {
        warnings.push('SALARY_APPORTION_FAILED');
        this.logger.warn(
          `event=erp-order-cost.salary.failed orderId=${orderId} error=${String(error)}`,
        );
      }
    } else if (!from) {
      warnings.push('NO_PRODUCTION_WINDOW');
    }

    const patternDev =
      order.patternDevelopmentCostInCostPrice && order.patternDevelopmentCostRub
        ? num(order.patternDevelopmentCostRub)
        : 0;
    const other = num(extras._sum.amount) + patternDev;

    const total = round2(materialsOwn + materialsErp + num(piecework._sum.amount) + salary + other);
    const planTotal = order.costEstimateTotalRub == null ? null : num(order.costEstimateTotalRub);
    const qtyPlan = order.items.reduce((sum, i) => sum + (i.qtyPlan ?? 0), 0);
    return {
      materials_own_rub: round2(materialsOwn),
      materials_erp_rub: round2(materialsErp),
      piecework_rub: round2(num(piecework._sum.amount)),
      salary_rub: round2(salary),
      other_rub: round2(other),
      total_rub: total,
      per_unit_rub: qtyGood > 0 ? round2(total / qtyGood) : 0,
      plan_total_rub: planTotal == null ? null : round2(planTotal),
      plan_per_unit_rub:
        planTotal == null || qtyPlan <= 0 ? null : round2(planTotal / qtyPlan),
      warnings,
    };
  }
}
