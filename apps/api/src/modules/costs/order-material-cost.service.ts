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

import { PrismaService } from '../../prisma/prisma.service.js';
import { TIRAGE_NEED_WHERE } from '../workshop-needs/workshop-need-scope.js';
import { erpMaterialFactByNeed } from './erp-material-fact.js';

const POSTED = 'POSTED';
const RUB = 'RUB';

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
      },
    });
    const needIds = needs.map((n) => n.id);

    const [issuedLines, returnsHeader, returnedLines, orderedLines, receivedLines, erpByNeed] =
      await Promise.all([
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
              },
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
              where: { workshopNeedId: { in: needIds } },
              select: {
                workshopNeedId: true,
                receivedQty: true,
                priceSnapshot: true,
                currencySnapshot: true,
              },
            })
          : Promise.resolve([]),
        erpMaterialFactByNeed(this.prisma, orderId),
      ]);

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

    const ordered = new Map<string, { qty: number; price: number | null; confirmed: boolean }>();
    for (const l of orderedLines) {
      if (!l.workshopNeedId) continue;
      const acc = ordered.get(l.workshopNeedId) ?? { qty: 0, price: null, confirmed: false };
      const qty = l.confirmedQty == null ? dec(l.qty) : dec(l.confirmedQty);
      acc.qty += qty;
      // Цена берётся подтверждённая, если поставщик её подтвердил: платить будем по ней.
      const price = l.confirmedPrice ?? l.price;
      if (price != null && (l.currency ?? RUB) === RUB) {
        acc.price = dec(price);
        acc.confirmed = acc.confirmed || l.confirmedPrice != null;
      }
      ordered.set(l.workshopNeedId, acc);
    }

    const received = new Map<string, { qty: number; price: number | null }>();
    for (const l of receivedLines) {
      if (!l.workshopNeedId) continue;
      const acc = received.get(l.workshopNeedId) ?? { qty: 0, price: null };
      acc.qty += dec(l.receivedQty);
      if (l.priceSnapshot != null && (l.currencySnapshot ?? RUB) === RUB) {
        acc.price = dec(l.priceSnapshot);
      }
      received.set(l.workshopNeedId, acc);
    }

    // --- сборка строк ---------------------------------------------------------
    const lines: ProductionMaterialLineDto[] = [];
    let erpTotal = 0;
    // Масштаб нормы: норма посчитана на весь план, а документ — про фактический выпуск.
    const scale = opts.qtyPlan > 0 ? opts.qtyGood / opts.qtyPlan : 1;

    for (const need of needs) {
      const description = need.description || need.sourceName || 'Материал';

      // Материал ERP — чужой факт, настройки к нему не применяются.
      if (need.erpManagedAt) {
        const fact = erpByNeed.get(need.id);
        if (!fact) continue;
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
        continue;
      }

      const iss = issued.get(need.id);
      const ord = ordered.get(need.id);
      const rec = received.get(need.id);
      const calculated = dec(need.calculatedQty) * scale;

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

      // --- цена
      const planned =
        need.quotedPrice != null && (need.quotedCurrency ?? RUB) === RUB
          ? dec(need.quotedPrice)
          : null;
      let price: number | null = null;
      let priceStep: MaterialPriceStep = 'NONE';
      switch (opts.priceSource) {
        case MaterialPriceSource.PLANNED:
          price = planned;
          priceStep = planned == null ? 'NONE' : 'PLANNED';
          break;
        case MaterialPriceSource.RECEIPT:
          if (rec?.price != null) {
            price = rec.price;
            priceStep = 'RECEIPT';
          } else {
            price = planned;
            priceStep = planned == null ? 'NONE' : 'PLANNED';
          }
          break;
        case MaterialPriceSource.PURCHASE:
        default:
          if (ord?.price != null) {
            price = ord.price;
            priceStep = ord.confirmed ? 'PURCHASE_CONFIRMED' : 'PURCHASE_ORDERED';
          } else if (rec?.price != null) {
            price = rec.price;
            priceStep = 'RECEIPT';
          } else {
            price = planned;
            priceStep = planned == null ? 'NONE' : 'PLANNED';
          }
          break;
      }
      if (price == null) warnings.push('MATERIAL_PRICE_UNKNOWN');

      lines.push({
        workshopNeedId: need.id,
        description,
        unit: need.unit,
        qty: round4(qty),
        qtyStep,
        unitPriceRub: price == null ? null : round2(price),
        priceStep,
        totalRub: round2(qty * (price ?? 0)),
      });
    }

    // Беспаспортные и непривязанные списания — только там, где расход вообще учитывается.
    const countsIssued =
      opts.recognition === OrderMaterialRecognition.BY_CONSUMPTION &&
      (opts.qtySource === MaterialQtySource.ISSUED ||
        opts.qtySource === MaterialQtySource.ISSUED_OR_CALCULATED);
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

    const totalRub = round2(
      lines.reduce((sum, l) => sum + (l.qtyStep === 'ERP' ? 0 : l.totalRub), 0),
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
