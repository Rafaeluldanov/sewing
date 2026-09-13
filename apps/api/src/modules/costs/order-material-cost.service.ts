import { Injectable, Logger } from '@nestjs/common';
import {
  MaterialPriceSource,
  MaterialQtySource,
  OrderMaterialRecognition,
  Prisma,
} from '@prisma/client';
import type {
  MaterialFactStep,
  MaterialPriceStep,
  ProductionMaterialLineDto,
} from '@sewing/shared/material-policy';
import { PURCHASE_ORDER_LINE_ACTIVE_STATUSES } from '@sewing/shared/purchase-orders';

import { PrismaService } from '../../prisma/prisma.service.js';
import { ACTIVE_CALCULATION_ESTIMATE_WHERE } from '../orders/cost-estimate-scope.js';
import { TIRAGE_NEED_WHERE } from '../workshop-needs/workshop-need-scope.js';
import { erpConsumptionSignals, erpMaterialFactByNeed } from './erp-material-fact.js';

const POSTED = 'POSTED';
const RUB = 'RUB';
const USD = 'USD';
const CANCELLED = 'CANCELLED';

const dec = (v: Prisma.Decimal | number | null | undefined): number =>
  v == null ? 0 : Number(v);
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;
const round4 = (v: number): number => Math.round((v + Number.EPSILON) * 10000) / 10000;

export type OrderMaterialCost = {
  lines: ProductionMaterialLineDto[];
  totalRub: number;
  /**
   * Материал ERP, собранный ПО СТРОКАМ разбивки. Это только детализация: авторитетная сумма
   * живёт в шапке списания ERP (`ErpMaterialConsumption.amountRub`), а строки могут быть не
   * присланы или не привязаны к потребности. Считать сумму по строкам значило бы молча терять
   * деньги там, где ERP прислала итог без разбивки.
   */
  erpLinesTotalRub: number;
  warnings: string[];
};

type Agg = { qty: number; rub: number };
const empty = (): Agg => ({ qty: 0, rub: 0 });

/**
 * Закупка / приёмка по потребности. Цена — СРЕДНЕВЗВЕШЕННАЯ: копим рубли по оценённой части
 * (`rub`, `pricedQty`) и делим. Аудит движка расчёта 13.09.2026, D1-6 ≡ E1-8: раньше цена
 * перезаписывалась каждой строкой («последняя побеждает»), и при двух строках ЗП/приёмки с
 * разными ценами Σ количества умножалась на случайную из них — сумма зависела от порядка выборки.
 */
type PricedAgg = {
  qty: number;
  pricedQty: number;
  rub: number;
  /** Была строка с ценой в USD, которую нечем перевести в рубли (E1-7). */
  usdNoRate: boolean;
  confirmed: boolean;
};
const emptyPriced = (): PricedAgg => ({
  qty: 0,
  pricedQty: 0,
  rub: 0,
  usdNoRate: false,
  confirmed: false,
});

/**
 * МАТЕРИАЛ В СЕБЕСТОИМОСТИ ЗАКАЗА — по двум настраиваемым осям.
 *
 * ⛔ ОСИ РАЗНЫЕ, И ЭТО НЕ ПЕДАНТИЗМ. План и факт различаются двумя признаками: количеством и
 * ценой. Закупка делает настоящей ЦЕНУ, но не расход — рулон берут на 60 м, когда нужно 47, и
 * остаток принадлежит складу, а не тиражу. Сведи их в один переключатель — и в отчёте появится
 * перерасход, которого не было, причём выглядеть он будет как вина цеха.
 *
 * ⛔ КАЖДАЯ ЦИФРА ПОДПИСАНА. У строки едут `qtyStep` и `priceStep`: «списано» / «принято» /
 * «заказано» / «расчёт по норме» и «подтверждённая закупка» / «плановая котировка». Три
 * настройки без подписи превращают сумму в загадку — одна и та же строка значит разное.
 *
 * ⛔ МАТЕРИАЛ ERP НАСТРОЙКАМИ НЕ УПРАВЛЯЕТСЯ. ERP списывает со своего склада по факту выпуска, с
 * конкретного рулона и по цене его партии (правило владельца §0.3). Это уже факт: подменять его
 * нормой или ценой закупки значило бы спорить с чужим учётом.
 *
 * Валюта (аудит движка расчёта 13.09.2026, E1-7): котировка, цена ЗП и снимок цены приёмки в USD
 * переводятся в рубли по курсу АКТИВНОЙ сметы (`OrderCostEstimate.usdRateRub`) — тем же, которым
 * посчитан план и которым автосписание оценило выдачу. Без курса строка получает `totalRub: null`
 * и код `MATERIAL_PRICE_USD_NO_RATE`: «нечем перевести» — не то же самое, что «стоило 0 ₽».
 */
@Injectable()
export class OrderMaterialCostService {
  private readonly logger = new Logger(OrderMaterialCostService.name);

  constructor(private readonly prisma: PrismaService) {}

  async forOrder(
    orderId: string,
    opts: {
      qtySource: MaterialQtySource;
      priceSource: MaterialPriceSource;
      recognition: OrderMaterialRecognition;
      /** Годный выпуск и план тиража — для масштабирования нормы. */
      qtyGood: number;
      qtyPlan: number;
    },
  ): Promise<OrderMaterialCost> {
    const warnings: string[] = [];

    const needs = await this.prisma.workshopNeed.findMany({
      where: { orderId, AND: [TIRAGE_NEED_WHERE] },
      select: {
        id: true,
        description: true,
        sourceName: true,
        unit: true,
        calculatedQty: true,
        quotedPrice: true,
        quotedCurrency: true,
        erpManagedAt: true,
        status: true,
      },
    });
    // Аудит движка расчёта 13.09.2026, D1-1: отменённая строка — не потребность (смета, документ
    // план→факт и доля на паспорт её не видят, здесь она уезжала в `materials_own_rub` нормой).
    // ЗП и приёмки по ней в затраты не берём, поэтому по отменённым строкам их и не читаем.
    // Остаётся только реальный расход, если материал успели выдать до отмены, — см. цикл строк.
    const needIds = needs.filter((n) => n.status !== CANCELLED).map((n) => n.id);

    const [
      issuedLines,
      returnsHeader,
      returnedLines,
      orderedLines,
      receivedLines,
      erpByNeed,
      erpSignals,
      estimate,
    ] = await Promise.all([
      this.prisma.materialIssueLine.findMany({
        where: { materialIssue: { orderId, status: POSTED } },
        select: {
          workshopNeedId: true,
          description: true,
          unit: true,
          issuedQty: true,
          totalCost: true,
        },
      }),
      this.prisma.materialIssueReturn.aggregate({
        where: { orderId, status: POSTED },
        _sum: { totalCost: true },
      }),
      this.prisma.materialIssueReturnLine.findMany({
        where: { materialIssueReturn: { orderId, status: POSTED } },
        select: {
          returnedQty: true,
          totalCost: true,
          materialIssueLine: { select: { workshopNeedId: true } },
        },
      }),
      needIds.length
        ? this.prisma.purchaseOrderLine.findMany({
            where: {
              workshopNeedId: { in: needIds },
              // Отменённая закупка — не обязательство: её строки в затратах не участвуют.
              purchaseOrder: { cancelledAt: null },
              // Аудит движка расчёта 13.09.2026, E1-8: отменённая СТРОКА живого ЗП — тоже не
              // обязательство (`PurchaseOrderLine.status` живёт отдельно от заголовка).
              status: { in: PURCHASE_ORDER_LINE_ACTIVE_STATUSES as string[] },
            },
            // Порядок задан ради воспроизводимости: сумма не должна зависеть от плана выборки.
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              workshopNeedId: true,
              qty: true,
              price: true,
              currency: true,
              confirmedQty: true,
              confirmedPrice: true,
            },
          })
        : Promise.resolve([]),
      needIds.length
        ? this.prisma.purchaseReceiptLine.findMany({
            where: {
              workshopNeedId: { in: needIds },
              // Аудит движка расчёта 13.09.2026, D1-6: отменённая приёмка — не «принято»
              // (та же выборка, что у документа план→факт).
              status: POSTED,
              purchaseReceipt: { status: POSTED },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              workshopNeedId: true,
              receivedQty: true,
              priceSnapshot: true,
              currencySnapshot: true,
            },
          })
        : Promise.resolve([]),
      erpMaterialFactByNeed(this.prisma, orderId),
      erpConsumptionSignals(this.prisma, orderId),
      // Аудит движка расчёта 13.09.2026, E1-7: курс USD активной сметы — им посчитан план
      // (`OrderCostEstimatesService`) и оценена авто-выдача (`resolveAutoIssueUnitCost`).
      this.prisma.orderCostEstimate.findFirst({
        where: { orderId, status: 'COMPLETED', AND: [ACTIVE_CALCULATION_ESTIMATE_WHERE] },
        orderBy: { version: 'desc' },
        select: { usdRateRub: true },
      }),
    ]);
    const usdRate = estimate?.usdRateRub == null ? null : dec(estimate.usdRateRub);
    /**
     * Цена в рублях: RUB — как есть, USD — по курсу сметы. `undefined` — цены нет,
     * `null` — цена есть, но перевести её в рубли нечем (E1-7).
     */
    const rubPrice = (
      price: Prisma.Decimal | null | undefined,
      currency: string | null | undefined,
    ): number | null | undefined => {
      if (price == null) return undefined;
      const cur = (currency ?? RUB).toUpperCase();
      if (cur === RUB) return dec(price);
      if (cur === USD && usdRate != null && usdRate > 0) return dec(price) * usdRate;
      return null;
    };

    // --- факты по потребностям ------------------------------------------------
    const issued = new Map<string, Agg>();
    const unlinkedIssued: ProductionMaterialLineDto[] = [];
    for (const l of issuedLines) {
      if (!l.workshopNeedId) {
        // Списание без привязки к потребности: описание строки — единственное, что о нём
        // известно. Терять его нельзя, это реальные деньги.
        unlinkedIssued.push({
          workshopNeedId: null,
          description: l.description,
          unit: l.unit,
          qty: round4(dec(l.issuedQty)),
          qtyStep: 'ISSUED',
          unitPriceRub:
            dec(l.issuedQty) > 0 ? round2(dec(l.totalCost) / dec(l.issuedQty)) : null,
          priceStep: 'PLANNED',
          totalRub: round2(dec(l.totalCost)),
        });
        continue;
      }
      const acc = issued.get(l.workshopNeedId) ?? empty();
      acc.qty += dec(l.issuedQty);
      acc.rub += dec(l.totalCost);
      issued.set(l.workshopNeedId, acc);
    }
    let returnLinesRub = 0;
    for (const r of returnedLines) {
      returnLinesRub += dec(r.totalCost);
      const needId = r.materialIssueLine?.workshopNeedId;
      if (!needId) continue;
      const acc = issued.get(needId) ?? empty();
      acc.qty -= dec(r.returnedQty);
      acc.rub -= dec(r.totalCost);
      issued.set(needId, acc);
    }
    // ⛔ Авторитетная сумма возврата — в ШАПКЕ документа: строк возврата может не быть вовсе
    // (частичный возврат оформляют суммой). Разницу нельзя терять — это живые деньги обратно на
    // склад, и без неё расход завышен.
    const returnResidualRub = round2(
      dec(returnsHeader._sum.totalCost) - returnLinesRub,
    );

    const ordered = new Map<string, PricedAgg>();
    for (const l of orderedLines) {
      if (!l.workshopNeedId) continue;
      const acc = ordered.get(l.workshopNeedId) ?? emptyPriced();
      const qty = l.confirmedQty == null ? dec(l.qty) : dec(l.confirmedQty);
      acc.qty += qty;
      // Цена берётся подтверждённая, если поставщик её подтвердил: платить будем по ней.
      const price = rubPrice(l.confirmedPrice ?? l.price, l.currency);
      if (price === null) {
        acc.usdNoRate = true;
      } else if (price !== undefined && qty > 0) {
        // D1-6 ≡ E1-8: взвешиваем количеством, а не перезаписываем.
        acc.pricedQty += qty;
        acc.rub += qty * price;
        acc.confirmed = acc.confirmed || l.confirmedPrice != null;
      }
      ordered.set(l.workshopNeedId, acc);
    }

    const received = new Map<string, PricedAgg>();
    for (const l of receivedLines) {
      if (!l.workshopNeedId) continue;
      const acc = received.get(l.workshopNeedId) ?? emptyPriced();
      const qty = dec(l.receivedQty);
      acc.qty += qty;
      const price = rubPrice(l.priceSnapshot, l.currencySnapshot);
      if (price === null) {
        acc.usdNoRate = true;
      } else if (price !== undefined && qty > 0) {
        acc.pricedQty += qty;
        acc.rub += qty * price;
      }
      received.set(l.workshopNeedId, acc);
    }
    /** Средневзвешенная цена по оценённой части закупки/приёмки; `null` — оценённой части нет. */
    const avgPrice = (acc: PricedAgg | undefined): number | null =>
      acc && acc.pricedQty > 0 ? acc.rub / acc.pricedQty : null;

    // --- сборка строк ---------------------------------------------------------
    const lines: ProductionMaterialLineDto[] = [];
    let erpTotal = 0;
    // Масштаб нормы: норма посчитана на весь план, а документ — про фактический выпуск.
    const scale = opts.qtyPlan > 0 ? opts.qtyGood / opts.qtyPlan : 1;
    // Беспаспортные и непривязанные списания — только там, где расход вообще учитывается.
    const countsIssued =
      opts.recognition === OrderMaterialRecognition.BY_CONSUMPTION &&
      (opts.qtySource === MaterialQtySource.ISSUED ||
        opts.qtySource === MaterialQtySource.ISSUED_OR_CALCULATED);
    // Аудит движка расчёта 13.09.2026, D1-12: ERP было что списывать (есть упакованные паспорта) —
    // значит, у строки под ERP без POSTED-факта расход не «нулевой», а ПОТЕРЯННЫЙ: FAILED/EMPTY,
    // ещё не отвечено или ERP не прислала разбивку. Такая строка едет нулём с предупреждением —
    // «тихо потерянный расход хуже явно пропущенного».
    const erpExpected =
      erpSignals.pending + erpSignals.posted + erpSignals.failed + erpSignals.empty > 0;
    let hasErpNeeds = erpByNeed.size > 0;

    for (const need of needs) {
      const description = need.description || need.sourceName || 'Материал';
      const cancelled = need.status === CANCELLED;
      const fact = erpByNeed.get(need.id);
      if (need.erpManagedAt) hasErpNeeds = true;

      // Материал ERP — чужой факт, настройки к нему не применяются.
      //
      // Аудит движка расчёта 13.09.2026, D1-13: ветка выбирается и по ФАКТУ ERP, а не только по
      // `erpManagedAt`: после `erp-unlink` строка снова «своя», но списанное ERP по ней никуда не
      // делось — считать по ней ещё и норму значило бы взять тот же материал дважды (второй раз
      // строкой «Материал ERP без разбивки»). Норму по такой строке не считаем; собственный
      // расход или закупка, появившиеся после отвязки, идут обычной веткой ниже.
      if (fact) {
        const qty = dec(fact.qty);
        const rub = dec(fact.rub);
        erpTotal += rub;
        lines.push({
          workshopNeedId: need.id,
          description,
          unit: need.unit ?? fact.unit,
          qty: round4(qty),
          qtyStep: 'ERP',
          unitPriceRub: qty > 0 ? round2(rub / qty) : null,
          priceStep: 'ERP',
          totalRub: round2(rub),
        });
        if (need.erpManagedAt) continue;
      } else if (need.erpManagedAt) {
        if (cancelled || !erpExpected) continue;
        // D1-12: строка под ERP, по которой ERP ничего не списала, — нулём и вслух.
        lines.push({
          workshopNeedId: need.id,
          description,
          unit: need.unit,
          qty: 0,
          qtyStep: 'ERP',
          unitPriceRub: null,
          priceStep: 'ERP',
          totalRub: 0,
        });
        warnings.push('ERP_MATERIAL_FACT_MISSING');
        continue;
      }

      const iss = issued.get(need.id);
      // D1-1: по отменённой строке — только реальный расход (и только там, где он вообще
      // учитывается); нормы, ЗП и приёмок у неё нет.
      if (cancelled && !(countsIssued && iss && iss.qty > 0)) continue;
      const ord = cancelled ? undefined : ordered.get(need.id);
      const rec = cancelled ? undefined : received.get(need.id);
      // D1-13: норма не считается, если материал по строке уже списала ERP (см. выше).
      const calculated = cancelled || fact ? 0 : dec(need.calculatedQty) * scale;

      // --- количество
      let qty = 0;
      let qtyStep: MaterialFactStep = 'CALCULATED';
      const useAllPurchased =
        opts.recognition === OrderMaterialRecognition.ALL_PURCHASED;
      if (useAllPurchased) {
        // Признание «вся закупка под заказ»: остаток рулона тоже затрата этого тиража.
        if (rec && rec.qty > 0) {
          qty = rec.qty;
          qtyStep = 'RECEIVED';
        } else if (ord && ord.qty > 0) {
          qty = ord.qty;
          qtyStep = 'ORDERED';
        } else {
          qty = calculated;
          qtyStep = 'CALCULATED';
        }
      } else {
        switch (opts.qtySource) {
          case MaterialQtySource.ISSUED:
            qty = iss?.qty ?? 0;
            qtyStep = 'ISSUED';
            break;
          case MaterialQtySource.CALCULATED:
            qty = calculated;
            qtyStep = 'CALCULATED';
            break;
          case MaterialQtySource.ORDERED:
            qty = ord?.qty ?? 0;
            qtyStep = 'ORDERED';
            break;
          case MaterialQtySource.RECEIVED:
            qty = rec?.qty ?? 0;
            qtyStep = 'RECEIVED';
            break;
          case MaterialQtySource.ISSUED_OR_CALCULATED:
          default:
            if (iss && iss.qty > 0) {
              qty = iss.qty;
              qtyStep = 'ISSUED';
            } else {
              qty = calculated;
              qtyStep = 'CALCULATED';
            }
            break;
        }
      }
      if (qty <= 0) continue;

      // --- цена (E1-7: USD — по курсу сметы, `null` — курса нет)
      const plannedRaw = rubPrice(need.quotedPrice, need.quotedCurrency);
      const planned = plannedRaw ?? null;
      const ordPrice = avgPrice(ord);
      const recPrice = avgPrice(rec);
      let price: number | null = null;
      let priceStep: MaterialPriceStep = 'NONE';
      // Среди ОПРОШЕННЫХ ступеней была цена в USD без курса.
      let sawUsdNoRate = plannedRaw === null;
      switch (opts.priceSource) {
        case MaterialPriceSource.PLANNED:
          price = planned;
          priceStep = planned == null ? 'NONE' : 'PLANNED';
          break;
        case MaterialPriceSource.RECEIPT:
          sawUsdNoRate = sawUsdNoRate || rec?.usdNoRate === true;
          if (recPrice != null) {
            price = recPrice;
            priceStep = 'RECEIPT';
          } else {
            price = planned;
            priceStep = planned == null ? 'NONE' : 'PLANNED';
          }
          break;
        case MaterialPriceSource.PURCHASE:
        default:
          sawUsdNoRate =
            sawUsdNoRate || ord?.usdNoRate === true || rec?.usdNoRate === true;
          if (ordPrice != null) {
            price = ordPrice;
            priceStep = ord?.confirmed ? 'PURCHASE_CONFIRMED' : 'PURCHASE_ORDERED';
          } else if (recPrice != null) {
            price = recPrice;
            priceStep = 'RECEIPT';
          } else {
            price = planned;
            priceStep = planned == null ? 'NONE' : 'PLANNED';
          }
          break;
      }
      // Цена есть только в USD, а курса нет — это не «цены нет» и тем более не 0 ₽.
      const usdNoRate = price == null && sawUsdNoRate;
      if (usdNoRate) warnings.push('MATERIAL_PRICE_USD_NO_RATE');
      else if (price == null) warnings.push('MATERIAL_PRICE_UNKNOWN');

      lines.push({
        workshopNeedId: need.id,
        description,
        unit: need.unit,
        qty: round4(qty),
        qtyStep,
        unitPriceRub: price == null ? null : round2(price),
        priceStep,
        totalRub: usdNoRate ? null : round2(qty * (price ?? 0)),
      });
    }

    if (countsIssued) {
      lines.push(...unlinkedIssued);
      if (returnResidualRub > 0.01) {
        lines.push({
          workshopNeedId: null,
          description: 'Возврат материала без разбивки по строкам',
          unit: null,
          qty: 0,
          qtyStep: 'ISSUED',
          unitPriceRub: null,
          priceStep: 'NONE',
          totalRub: -returnResidualRub,
        });
      }
    }

    // D1-12: состояние ответов ERP — сигналы на уровне заказа. FAILED/EMPTY/молчание по паспорту
    // прячут его материал целиком, `uncoveredQty` — ERP списала, но партиями не покрыла.
    if (hasErpNeeds) {
      if (erpSignals.failed > 0) warnings.push('ERP_CONSUMPTION_FAILED');
      if (erpSignals.pending > 0) warnings.push('ERP_CONSUMPTION_PENDING');
      if (erpSignals.empty > 0) warnings.push('ERP_CONSUMPTION_EMPTY');
      if (dec(erpSignals.uncoveredQty) > 0) warnings.push('ERP_UNCOVERED_QTY');
    }

    const totalRub = round2(
      lines.reduce(
        (sum, l) => sum + (l.qtyStep === 'ERP' ? 0 : (l.totalRub ?? 0)),
        0,
      ),
    );
    if (lines.length === 0) warnings.push('NO_MATERIAL_FACT');

    return {
      lines,
      totalRub,
      erpLinesTotalRub: round2(erpTotal),
      warnings: [...new Set(warnings)],
    };
  }
}
