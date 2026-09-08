import { Injectable, Logger } from '@nestjs/common';
import { EntryStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import { PassportRealCostService } from './passport-real-cost.service.js';
import { erpMaterialCostByPassport } from './erp-material-fact.js';

const POSTED = 'POSTED';
/** Завершённая сессия подкроя — та же выборка, что и у зарплаты (`computeRecutSeconds`). */
const RECUT_DONE = 'DONE';
const RUB = 'RUB';

const num = (value: Prisma.Decimal | number | null | undefined): number =>
  value == null ? 0 : Number(value);
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export type OrderFactCost = {
  materials_own_rub: number;
  materials_erp_rub: number;
  piecework_rub: number;
  /**
   * Сдельная, ещё НЕ подтверждённая (`PENDING`/`PENDING_RELEASE`): коробка не закрыта.
   * В `total_rub` не входит — это не трата, а обещание. Отдаётся отдельно, чтобы разрыв
   * между «фактом на сейчас» и окончательной суммой был виден, а не открывался потом
   * сверкой с отчётом себестоимости (он считает начисления вместе с ожидающими).
   */
  piecework_pending_rub: number;
  /** Повременная доплата за подкрой (`RecutSession`) — прямые деньги по заказу. */
  recut_rub: number;
  salary_rub: number;
  other_rub: number;
  total_rub: number;
  per_unit_rub: number;
  plan_total_rub: number | null;
  plan_per_unit_rub: number | null;
  warnings: string[];
};

/**
 * ФАКТИЧЕСКАЯ СЕБЕСТОИМОСТЬ ЗАКАЗА — то, что легло в документ выпуска.
 *
 * Живёт в `costs`, а не в `integrations`: это себестоимость цеха, а ERP лишь один из её
 * читателей. Считается по заказу, а не по паспорту.
 *
 * ⛔ Компоненты отдаются РАЗДЕЛЬНО (свой материал, материал ERP, сдельная, подкрой, разнесённый
 * оклад, прочие расходы) и все сразу. Что из них считать себестоимостью заказа — решение
 * владельца, и оно должно приниматься на живых числах, а не задним числом по потерянным данным:
 * собрать компонент, которого не собрали, потом будет уже нечем.
 *
 * Источники не пересекаются: свои материалы цеха (`MaterialIssue` нетто возвратов) и материалы,
 * списанные ERP по выпуску (у цеха своего документа расхода на них нет). Подкрой не пересекается
 * со сдельной: `RecutSession` — отдельная повременная оплата, `OperationEntry` она не пишет.
 *
 * ⛔ ЧЕТЫРЕ ГРАБЛИ, каждая стоила денег в сумме документа (08.09.2026):
 *
 *   1. Считали по паспортам, попавшим в СДАЧУ (упакованным), и всё, что к ним не привязано,
 *      исчезало: `MaterialIssue.passportId` NULLABLE — списание на заказ целиком паспорта не
 *      имеет (а это основной путь, ручной); расход и работа по отменённому или целиком
 *      бракованному паспорту — тоже деньги заказа. Теперь материал, подкрой и прочие расходы
 *      берутся ПО ЗАКАЗУ, а сдельная и оклад — по ВСЕМ его паспортам, а не только по сданным.
 *   2. Политика `materialsAndHardwareCostPolicy = EXCLUDE` («материалы не в себестоимости»)
 *      обнуляла только свой материал, а материал ERP продолжал суммироваться. Политика — про
 *      материал как таковой, чей склад — неважно.
 *   3. `OrderExtraCost.currency` игнорировалась: строки в USD складывались с рублёвыми как рубли.
 *      Конвертации на MVP нет, поэтому не-рублёвые строки в сумму НЕ идут, но о них предупреждаем —
 *      тихо потерянный расход хуже явно пропущенного.
 *   4. Подкрой (`RecutSession.amount`) не считался вовсе, хотя это прямые деньги по заказу и
 *      возникают они именно на проблемных тиражах, где себестоимость и смотрят.
 */
@Injectable()
export class OrderFactCostService {
  private readonly logger = new Logger(OrderFactCostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passportCost: PassportRealCostService,
  ) {}

  /**
   * @param orderId  заказ, по которому собран документ выпуска.
   * @param qtyGood  годный выпуск документа — знаменатель себестоимости за единицу.
   *
   * ⛔ Паспорта НЕ передаются снаружи: себестоимость считается по всему заказу, а не по строкам
   * документа. Иначе работа и материал по паспорту, не дошедшему до упаковки, пропали бы из
   * трат, хотя цех их понёс.
   */
  async factCostForOrder(orderId: string, qtyGood: number): Promise<OrderFactCost> {
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
        materials_own_rub: 0, materials_erp_rub: 0,
        piecework_rub: 0, piecework_pending_rub: 0, recut_rub: 0,
        salary_rub: 0, other_rub: 0, total_rub: 0, per_unit_rub: 0,
        plan_total_rub: null, plan_per_unit_rub: null,
        warnings: ['ORDER_NOT_FOUND'],
      };
    }
    const excluded = order.materialsAndHardwareCostPolicy === 'EXCLUDE';

    // Все паспорта заказа, а не только упакованные: труд по отменённому паспорту тоже оплачен.
    const passports = await this.prisma.passport.findMany({
      where: { orderId },
      select: { id: true },
    });
    const passportIds = passports.map((p) => p.id);
    // Расход материала — по заказу: и документы паспортов, и оформленные на заказ целиком.
    const materialWhere = { status: POSTED, orderId };

    const [issues, returns, piecework, pending, recut, extras] = await Promise.all([
      this.prisma.materialIssue.aggregate({
        where: materialWhere,
        _sum: { totalCost: true },
      }),
      this.prisma.materialIssueReturn.aggregate({
        where: materialWhere,
        _sum: { totalCost: true },
      }),
      this.prisma.operationEntry.aggregate({
        where: { passportId: { in: passportIds }, status: EntryStatus.APPROVED },
        _sum: { amount: true },
      }),
      this.prisma.operationEntry.aggregate({
        where: {
          passportId: { in: passportIds },
          status: { in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING] },
        },
        _sum: { amount: true },
      }),
      this.prisma.recutSession.aggregate({
        where: { orderId, status: RECUT_DONE },
        _sum: { amount: true },
      }),
      // Валюта прочих расходов — не декоративное поле (грабля 3).
      this.prisma.orderExtraCost.groupBy({
        by: ['currency'],
        where: { orderId, includeInCostPrice: true },
        _sum: { amount: true },
      }),
    ]);
    const erpByPassport = await erpMaterialCostByPassport(this.prisma, passportIds);
    let materialsErpFact = 0;
    for (const value of erpByPassport.values()) materialsErpFact += num(value);

    // Политика «материалы вне себестоимости» — про материал, а не про то, чей склад (грабля 2).
    const materialsOwn = excluded
      ? 0
      : num(issues._sum.totalCost) - num(returns._sum.totalCost);
    const materialsErp = excluded ? 0 : materialsErpFact;
    if (excluded) warnings.push('MATERIALS_EXCLUDED_BY_POLICY');
    if (!excluded && materialsOwn === 0 && materialsErp === 0) {
      warnings.push('NO_MATERIAL_FACT');
    }

    let extraRub = 0;
    for (const row of extras) {
      if ((row.currency ?? RUB) === RUB) {
        extraRub += num(row._sum.amount);
      } else if (num(row._sum.amount) !== 0) {
        warnings.push('EXTRA_COSTS_NON_RUB_SKIPPED');
        this.logger.warn(
          `event=order-fact-cost.extra.non_rub orderId=${orderId} ` +
            `currency=${row.currency} amount=${String(row._sum.amount)}`,
        );
      }
    }

    // Разнесённый оклад: считаем ПО ОКНУ ПРОИЗВОДСТВА заказа и берём только его паспорта.
    // ⛔ Отдельной строкой, а не внутри сдельной: у цеха оклад — почти половина денег труда,
    // и владелец решает, входит ли он в себестоимость заказа. Это РАЗНОСКА времени, а не
    // выплата: время без паспорта (планёрка, простой) не ложится ни на один заказ.
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
          `event=order-fact-cost.salary.failed orderId=${orderId} error=${String(error)}`,
        );
      }
    } else if (!from) {
      warnings.push('NO_PRODUCTION_WINDOW');
    }

    const patternDev =
      order.patternDevelopmentCostInCostPrice && order.patternDevelopmentCostRub
        ? num(order.patternDevelopmentCostRub)
        : 0;
    const other = extraRub + patternDev;

    const pieceworkRub = num(piecework._sum.amount);
    const pieceworkPending = num(pending._sum.amount);
    // Незакрытая коробка — не «мелочь на потом»: пока начисления не подтверждены, сумма документа
    // заведомо меньше того, что цех уже заработал.
    if (pieceworkPending > 0) warnings.push('PIECEWORK_PENDING');
    const recutRub = num(recut._sum.amount);

    const total = round2(
      materialsOwn + materialsErp + pieceworkRub + recutRub + salary + other,
    );
    const planTotal = order.costEstimateTotalRub == null ? null : num(order.costEstimateTotalRub);
    const qtyPlan = order.items.reduce((sum, i) => sum + (i.qtyPlan ?? 0), 0);
    return {
      materials_own_rub: round2(materialsOwn),
      materials_erp_rub: round2(materialsErp),
      piecework_rub: round2(pieceworkRub),
      piecework_pending_rub: round2(pieceworkPending),
      recut_rub: round2(recutRub),
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
