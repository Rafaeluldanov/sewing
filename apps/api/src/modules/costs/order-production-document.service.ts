import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type EntryStatus, type PricingMode } from '@prisma/client';
import type {
  OrderProductionBreakdownDto,
  OrderProductionDocumentDto,
  OrderProductionMaterialRowDto,
  OrderProductionOperationRowDto,
  ProductionDocMaterialPlanSource,
} from '@sewing/shared/order-production-document';

import { PrismaService } from '../../prisma/prisma.service.js';
import { ACTIVE_CALCULATION_NEED_WHERE } from '../workshop-needs/workshop-need-scope.js';

/** Начисления, считающиеся «фактом» на текущий момент (не отменённые). */
const FACT_ENTRY_STATUSES: EntryStatus[] = [
  'PENDING',
  'PENDING_RELEASE',
  'APPROVED',
];

/**
 * Документ производства по заказу: план → факт построчно (материалы +
 * операции) с расхождениями и проваливанием по размерам/цветам.
 *
 * Read-модель поверх существующих данных (новых таблиц нет) — разворачивает
 * агрегатный `OrderActualMaterialsService` в подробный документ по одному
 * заказу. Контракт и источники — см.
 * `packages/shared/src/order-production-document.ts`.
 *
 * Ключевые решения (согласованы с заказчиком):
 *   - ФАКТ материала показываем ДВОЙНОЙ: «списано» (`MaterialIssue`, нетто
 *     возвратов — реальный расход) и «принято» (`PurchaseReceiptLine`);
 *     прямая с/с факт считается по «списано»;
 *   - ФАКТ операций — «на текущий момент»: все `OperationEntry`, кроме
 *     CANCELLED/REVERSED (включая ещё не подтверждённые PENDING_RELEASE),
 *     подтверждённая часть подсвечивается отдельно;
 *   - идентичность материала = `WorkshopNeed` (на неё ссылаются строка
 *     сметы, списание и приёмка); непривязанный факт собирается в
 *     синтетические строки.
 *
 * Себестоимость ПОТРЕБЛЯЕТ факт — проводок не пишет.
 */
@Injectable()
export class OrderProductionDocumentService {
  constructor(private readonly prisma: PrismaService) {}

  private m(v: Prisma.Decimal): Prisma.Decimal {
    return v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }
  private q(v: Prisma.Decimal): Prisma.Decimal {
    return v.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  }

  async getDocument(orderId: string): Promise<OrderProductionDocumentDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        status: true,
        color: true,
        customerUnitPrice: true,
        customerCurrency: true,
        patternNameSnapshot: true,
        patternArticleSnapshot: true,
        client: { select: { name: true } },
        patternItem: { select: { name: true, article: true } },
        items: {
          select: {
            sizeId: true,
            qtyPlan: true,
            size: { select: { code: true } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Заказ не найден');

    const docWarnings = new Set<string>();

    const qtyPlanTotal = order.items.reduce((s, it) => s + (it.qtyPlan ?? 0), 0);
    // Плановое количество по размеру (для провала операций).
    const planQtyBySizeCode = new Map<string, number>();
    for (const it of order.items) {
      const code = it.size?.code ?? it.sizeId;
      planQtyBySizeCode.set(
        code,
        (planQtyBySizeCode.get(code) ?? 0) + (it.qtyPlan ?? 0),
      );
    }

    // -------------------------------------------------------------------
    // Паспорта заказа — факт выпуска и словарь для провалов по размеру/цвету.
    // -------------------------------------------------------------------
    const passports = await this.prisma.passport.findMany({
      where: { orderId },
      select: {
        qtyCut: true,
        qtyGood: true,
        qtyDefect: true,
        status: true,
      },
    });
    let qtyCutTotal = 0;
    let qtyGoodTotal = 0;
    let qtyGoodPackedTotal = 0;
    let qtyDefectTotal = 0;
    for (const p of passports) {
      qtyCutTotal += p.qtyCut;
      qtyGoodTotal += p.qtyGood;
      qtyDefectTotal += p.qtyDefect;
      if (p.status === 'PACKED') qtyGoodPackedTotal += p.qtyGood;
    }
    const readinessPct =
      qtyPlanTotal > 0
        ? Math.round((qtyGoodPackedTotal / qtyPlanTotal) * 100)
        : 0;

    // Активная смета (latest COMPLETED) — план материалов + курс USD.
    const estimate = await this.prisma.orderCostEstimate.findFirst({
      where: { orderId, status: 'COMPLETED' },
      orderBy: { version: 'desc' },
      select: {
        usdRateRub: true,
        lines: {
          select: {
            workshopNeedId: true,
            kind: true,
            lineTotalRub: true,
          },
        },
      },
    });
    const planRubByNeed = new Map<string, Prisma.Decimal>();
    if (estimate) {
      for (const ln of estimate.lines) {
        if (ln.workshopNeedId == null) continue;
        if (ln.kind !== 'MATERIAL' && ln.kind !== 'HARDWARE') continue;
        planRubByNeed.set(
          ln.workshopNeedId,
          (planRubByNeed.get(ln.workshopNeedId) ?? new Prisma.Decimal(0)).add(
            ln.lineTotalRub,
          ),
        );
      }
    }

    const materials = await this.buildMaterials(
      orderId,
      estimate?.usdRateRub ?? null,
      planRubByNeed,
      docWarnings,
    );
    const operations = await this.buildOperations(
      orderId,
      order.items,
      planQtyBySizeCode,
      qtyPlanTotal,
      docWarnings,
    );

    // -------------------------------------------------------------------
    // Итоги.
    // -------------------------------------------------------------------
    let planMaterials = new Prisma.Decimal(0);
    let issuedMaterials = new Prisma.Decimal(0);
    let receivedMaterials = new Prisma.Decimal(0);
    for (const r of materials) {
      if (r.planRub != null) planMaterials = planMaterials.add(r.planRub);
      issuedMaterials = issuedMaterials.add(r.issuedRub);
      receivedMaterials = receivedMaterials.add(r.receivedRub);
    }
    let planOperations = new Prisma.Decimal(0);
    let factOperations = new Prisma.Decimal(0);
    for (const r of operations) {
      if (r.planRub != null) planOperations = planOperations.add(r.planRub);
      factOperations = factOperations.add(r.factRub);
    }

    planMaterials = this.m(planMaterials);
    issuedMaterials = this.m(issuedMaterials);
    receivedMaterials = this.m(receivedMaterials);
    planOperations = this.m(planOperations);
    factOperations = this.m(factOperations);
    const planDirect = this.m(planMaterials.add(planOperations));
    const factDirect = this.m(issuedMaterials.add(factOperations));

    // Выручка — только в RUB (как в OrderActualMaterialsService / v2).
    let revenueRub: string | null = null;
    let marginRub: string | null = null;
    if (
      order.customerUnitPrice != null &&
      (order.customerCurrency ?? 'RUB') === 'RUB' &&
      qtyPlanTotal > 0
    ) {
      const rev = this.m(
        new Prisma.Decimal(order.customerUnitPrice).mul(qtyPlanTotal),
      );
      revenueRub = rev.toFixed(2);
      marginRub = this.m(rev.sub(factDirect)).toFixed(2);
    }

    const nomenclatureName =
      order.patternItem?.name ?? order.patternNameSnapshot ?? null;
    const nomenclatureArticle =
      order.patternItem?.article ?? order.patternArticleSnapshot ?? null;

    // Себестоимость за единицу: план — по плановому количеству; факт — по
    // фактически выпущенному годному (Σ qtyGood). На незавершённом заказе
    // фактическая единичная с/с частичная (см. плашку готовности).
    const planUnitCost =
      qtyPlanTotal > 0 ? this.m(planDirect.div(qtyPlanTotal)) : null;
    const factUnitCost =
      qtyGoodTotal > 0 ? this.m(factDirect.div(qtyGoodTotal)) : null;
    const unitCostVariance =
      planUnitCost != null && factUnitCost != null
        ? this.m(factUnitCost.sub(planUnitCost))
        : null;

    return {
      header: {
        orderId: order.id,
        orderNumber: order.number,
        status: order.status,
        clientName: order.client?.name ?? null,
        nomenclatureName,
        nomenclatureArticle,
        color: order.color ?? null,
        qtyPlanTotal,
        qtyCutTotal,
        qtyGoodPackedTotal,
        qtyGoodTotal,
        qtyDefectTotal,
        readinessPct,
        revenueRub,
        revenueCurrency:
          order.customerUnitPrice != null
            ? (order.customerCurrency ?? 'RUB')
            : null,
        planUnitCostRub: planUnitCost != null ? planUnitCost.toFixed(2) : null,
        factUnitCostRub: factUnitCost != null ? factUnitCost.toFixed(2) : null,
        unitCostVarianceRub:
          unitCostVariance != null ? unitCostVariance.toFixed(2) : null,
      },
      materials,
      operations,
      totals: {
        planMaterialsRub: planMaterials.toFixed(2),
        issuedMaterialsRub: issuedMaterials.toFixed(2),
        receivedMaterialsRub: receivedMaterials.toFixed(2),
        varianceMaterialsRub: this.m(issuedMaterials.sub(planMaterials)).toFixed(
          2,
        ),
        planOperationsRub: planOperations.toFixed(2),
        factOperationsRub: factOperations.toFixed(2),
        varianceOperationsRub: this.m(
          factOperations.sub(planOperations),
        ).toFixed(2),
        planDirectRub: planDirect.toFixed(2),
        factDirectRub: factDirect.toFixed(2),
        varianceDirectRub: this.m(factDirect.sub(planDirect)).toFixed(2),
        revenueRub,
        marginRub,
      },
      warnings: [...docWarnings],
    };
  }

  // ===================================================================
  //  МАТЕРИАЛЫ
  // ===================================================================
  private async buildMaterials(
    orderId: string,
    usdRateRub: Prisma.Decimal | null,
    planRubByNeed: Map<string, Prisma.Decimal>,
    docWarnings: Set<string>,
  ): Promise<OrderProductionMaterialRowDto[]> {
    // Аккумулятор строки материала.
    type Acc = {
      key: string;
      name: string;
      unit: string;
      materialRole: string | null;
      planQty: Prisma.Decimal | null;
      planRub: Prisma.Decimal | null;
      planSource: ProductionDocMaterialPlanSource;
      issuedQty: Prisma.Decimal;
      issuedRub: Prisma.Decimal;
      receivedQty: Prisma.Decimal;
      receivedRub: Prisma.Decimal;
      warnings: Set<string>;
      // провал по размеру/цвету (только списание): `${sizeCode}|${color}` → суммы
      breakdown: Map<
        string,
        { sizeCode: string | null; color: string | null; qty: Prisma.Decimal; rub: Prisma.Decimal }
      >;
    };
    const rows = new Map<string, Acc>();
    const ensure = (
      key: string,
      seed: Partial<Acc> & Pick<Acc, 'name' | 'unit'>,
    ): Acc => {
      let acc = rows.get(key);
      if (!acc) {
        acc = {
          key,
          name: seed.name,
          unit: seed.unit,
          materialRole: seed.materialRole ?? null,
          planQty: seed.planQty ?? null,
          planRub: seed.planRub ?? null,
          planSource: seed.planSource ?? 'NONE',
          issuedQty: new Prisma.Decimal(0),
          issuedRub: new Prisma.Decimal(0),
          receivedQty: new Prisma.Decimal(0),
          receivedRub: new Prisma.Decimal(0),
          warnings: new Set<string>(),
          breakdown: new Map(),
        };
        rows.set(key, acc);
      }
      return acc;
    };

    // 1. Плановые строки из потребности цеха (идентичность материала).
    // Фича «Варианты просчёта»: план — только по строкам активного
    // (выбранного) варианта, иначе план задваивается.
    const needs = await this.prisma.workshopNeed.findMany({
      where: {
        orderId,
        NOT: { status: 'CANCELLED' },
        AND: [ACTIVE_CALCULATION_NEED_WHERE],
      },
      select: {
        id: true,
        description: true,
        sourceName: true,
        materialRole: true,
        unit: true,
        calculatedQty: true,
        quotedPrice: true,
        quotedCurrency: true,
      },
    });
    for (const wn of needs) {
      // Деньги плана: из сметы, иначе calculatedQty × quotedPrice (RUB).
      let planRub: Prisma.Decimal | null = null;
      let planSource: ProductionDocMaterialPlanSource = 'NONE';
      const fromEstimate = planRubByNeed.get(wn.id);
      if (fromEstimate != null) {
        planRub = fromEstimate;
        planSource = 'COST_ESTIMATE';
      } else if (wn.quotedPrice != null) {
        if ((wn.quotedCurrency ?? 'RUB') === 'RUB') {
          planRub = new Prisma.Decimal(wn.calculatedQty).mul(wn.quotedPrice);
          planSource = 'WORKSHOP_NEED';
        } else {
          docWarnings.add('PLAN_USD_SKIPPED');
        }
      }
      ensure(wn.id, {
        name: wn.description || wn.sourceName || 'Материал',
        unit: wn.unit,
        materialRole: wn.materialRole,
        planQty: new Prisma.Decimal(wn.calculatedQty),
        planRub: planRub != null ? this.m(planRub) : null,
        planSource,
      });
    }

    // 2. Факт «списано» — POSTED MaterialIssueLine (нетто возвратов).
    const issueLines = await this.prisma.materialIssueLine.findMany({
      where: { materialIssue: { orderId, status: 'POSTED' } },
      select: {
        workshopNeedId: true,
        description: true,
        unit: true,
        materialRole: true,
        issuedQty: true,
        totalCost: true,
        materialIssue: {
          select: {
            passport: {
              select: { color: true, size: { select: { code: true } } },
            },
          },
        },
        returnLines: { select: { returnedQty: true, totalCost: true } },
      },
    });
    for (const l of issueLines) {
      let netQty = new Prisma.Decimal(l.issuedQty);
      let netRub = new Prisma.Decimal(l.totalCost);
      for (const r of l.returnLines) {
        netQty = netQty.sub(r.returnedQty);
        netRub = netRub.sub(r.totalCost);
      }
      const key = l.workshopNeedId ?? `desc:${l.description}`;
      if (l.workshopNeedId == null) docWarnings.add('ISSUE_NOT_LINKED');
      const acc = ensure(key, {
        name: l.description,
        unit: l.unit,
        materialRole: l.materialRole,
      });
      acc.issuedQty = acc.issuedQty.add(netQty);
      acc.issuedRub = acc.issuedRub.add(netRub);
      // Провал по размеру/цвету списания.
      const sizeCode = l.materialIssue.passport?.size?.code ?? null;
      const color = l.materialIssue.passport?.color ?? null;
      const bk = `${sizeCode ?? ''}|${color ?? ''}`;
      const b = acc.breakdown.get(bk) ?? {
        sizeCode,
        color,
        qty: new Prisma.Decimal(0),
        rub: new Prisma.Decimal(0),
      };
      b.qty = b.qty.add(netQty);
      b.rub = b.rub.add(netRub);
      acc.breakdown.set(bk, b);
    }

    // 3. Факт «принято» — POSTED PurchaseReceiptLine по заказу.
    const receiptLines = await this.prisma.purchaseReceiptLine.findMany({
      where: {
        status: 'POSTED',
        purchaseReceipt: { status: 'POSTED' },
        OR: [
          { purchaseReceipt: { customerOrderId: orderId } },
          { workshopNeed: { orderId } },
        ],
      },
      select: {
        workshopNeedId: true,
        receivedQty: true,
        priceSnapshot: true,
        currencySnapshot: true,
        workshopNeed: {
          select: { description: true, unit: true, materialRole: true },
        },
      },
    });
    for (const l of receiptLines) {
      const key = l.workshopNeedId ?? 'recv:unlinked';
      if (l.workshopNeedId == null) docWarnings.add('RECEIPT_NOT_LINKED');
      const acc = ensure(key, {
        name: l.workshopNeed?.description ?? 'Приёмки без привязки к потребности',
        unit: l.workshopNeed?.unit ?? '',
        materialRole: l.workshopNeed?.materialRole ?? null,
      });
      acc.receivedQty = acc.receivedQty.add(l.receivedQty);
      if (l.priceSnapshot == null) {
        acc.warnings.add('NO_PRICE');
        docWarnings.add('NO_PRICE');
        continue;
      }
      const base = new Prisma.Decimal(l.receivedQty).mul(l.priceSnapshot);
      const currency = l.currencySnapshot ?? 'RUB';
      if (currency === 'RUB') {
        acc.receivedRub = acc.receivedRub.add(base);
      } else if (usdRateRub != null) {
        acc.receivedRub = acc.receivedRub.add(base.mul(usdRateRub));
      } else {
        acc.warnings.add('USD_NO_RATE');
        docWarnings.add('USD_NO_RATE');
      }
    }

    // Материализуем строки.
    const out: OrderProductionMaterialRowDto[] = [];
    for (const acc of rows.values()) {
      const issuedRub = this.m(acc.issuedRub);
      const planRub = acc.planRub != null ? this.m(acc.planRub) : null;
      const breakdown: OrderProductionBreakdownDto[] = [...acc.breakdown.values()]
        .map((b) => ({
          sizeCode: b.sizeCode,
          color: b.color,
          planQty: null,
          factQty: this.q(b.qty).toFixed(4),
          factRub: this.m(b.rub).toFixed(2),
        }))
        .sort((a, b) => (a.sizeCode ?? '').localeCompare(b.sizeCode ?? ''));
      out.push({
        key: acc.key,
        name: acc.name,
        unit: acc.unit,
        materialRole: acc.materialRole,
        planQty: acc.planQty != null ? this.q(acc.planQty).toFixed(4) : null,
        planRub: planRub != null ? planRub.toFixed(2) : null,
        planSource: acc.planSource,
        issuedQty: this.q(acc.issuedQty).toFixed(4),
        issuedRub: issuedRub.toFixed(2),
        receivedQty: this.q(acc.receivedQty).toFixed(4),
        receivedRub: this.m(acc.receivedRub).toFixed(2),
        varianceRub:
          planRub != null ? this.m(issuedRub.sub(planRub)).toFixed(2) : null,
        warnings: [...acc.warnings],
        breakdown,
      });
    }
    // Сортировка: сначала строки с планом (по убыванию перерасхода), затем
    // непривязанный факт; внутри — по имени.
    out.sort((a, b) => {
      const ap = a.planRub != null ? 0 : 1;
      const bp = b.planRub != null ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const av = a.varianceRub != null ? Number(a.varianceRub) : -Infinity;
      const bv = b.varianceRub != null ? Number(b.varianceRub) : -Infinity;
      if (bv !== av) return bv - av;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  // ===================================================================
  //  ОПЕРАЦИИ
  // ===================================================================
  private async buildOperations(
    orderId: string,
    items: { sizeId: string; qtyPlan: number; size: { code: string } | null }[],
    planQtyBySizeCode: Map<string, number>,
    qtyPlanTotal: number,
    docWarnings: Set<string>,
  ): Promise<OrderProductionOperationRowDto[]> {
    // Эффективные шаги маршрута: снимок заказа (источник истины после старта),
    // fallback — live-шаблон (для незапущенных заказов). Логика денег/времени
    // зеркалит OrderOperationPlanService.
    const opSelect = {
      id: true,
      code: true,
      name: true,
      pricingMode: true,
      fixedRate: true,
      timeNormMode: true,
      timeNormSec: true,
      salaryPlanRubPerShift: true,
      salaryPlanShiftSeconds: true,
      ratesBySize: { select: { sizeId: true, rate: true } },
      timeNormsBySize: { select: { sizeId: true, seconds: true } },
    } as const;

    const snapshot = await this.prisma.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
      select: {
        index: true,
        rateOverride: true,
        timeNormSecOverride: true,
        pricingModeOverride: true,
        sizeOverrides: { select: { sizeId: true, rate: true, seconds: true } },
        operation: { select: opSelect },
      },
    });

    type Step = {
      index: number;
      rateOverride: Prisma.Decimal | null;
      timeNormSecOverride: number | null;
      pricingModeOverride: PricingMode | null;
      sizeOverrides: { sizeId: string; rate: Prisma.Decimal | null; seconds: number | null }[];
      operation: (typeof snapshot)[number]['operation'];
    };
    let steps: Step[] = snapshot;

    if (steps.length === 0) {
      // Fallback: live-шаблон (заказ не запущен — снимка ещё нет).
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          routeTemplate: {
            select: {
              steps: {
                orderBy: { index: 'asc' },
                select: {
                  index: true,
                  isOptional: true,
                  rateOverride: true,
                  operation: { select: opSelect },
                },
              },
            },
          },
        },
      });
      const tSteps = order?.routeTemplate?.steps ?? [];
      steps = tSteps
        .filter((s) => s.isOptional !== true)
        .map((s) => ({
          index: s.index,
          rateOverride: s.rateOverride,
          timeNormSecOverride: null,
          pricingModeOverride: null,
          sizeOverrides: [],
          operation: s.operation,
        }));
      if (steps.length === 0) docWarnings.add('NO_ROUTE');
    }
    if (qtyPlanTotal === 0) docWarnings.add('NO_PLAN_QTY');

    type OpAcc = {
      key: string;
      index: number;
      code: string;
      name: string;
      planQty: number | null;
      planTimeSec: number | null;
      planRub: Prisma.Decimal | null;
      factQty: number;
      factRub: Prisma.Decimal;
      factApprovedRub: Prisma.Decimal;
      breakdown: Map<
        string,
        { sizeCode: string | null; color: string | null; qty: number; rub: Prisma.Decimal }
      >;
    };
    const ops = new Map<string, OpAcc>();

    // --- ПЛАН по шагам маршрута ---
    for (const step of steps) {
      const op = step.operation;
      if (!op) continue;
      const acc: OpAcc = ops.get(op.id) ?? {
        key: op.id,
        index: step.index,
        code: op.code,
        name: op.name || op.code,
        planQty: qtyPlanTotal > 0 ? qtyPlanTotal : null,
        planTimeSec: null,
        planRub: null,
        factQty: 0,
        factRub: new Prisma.Decimal(0),
        factApprovedRub: new Prisma.Decimal(0),
        breakdown: new Map(),
      };

      const ratesBySize = new Map(op.ratesBySize.map((r) => [r.sizeId, r.rate]));
      const timeBySize = new Map(
        op.timeNormsBySize.map((t) => [t.sizeId, t.seconds]),
      );
      const sizeOvRate = new Map<string, Prisma.Decimal>();
      const sizeOvSec = new Map<string, number>();
      for (const o of step.sizeOverrides) {
        if (o.rate != null) sizeOvRate.set(o.sizeId, o.rate);
        if (o.seconds != null) sizeOvSec.set(o.sizeId, o.seconds);
      }
      const salaryPerSec =
        op.salaryPlanRubPerShift != null
          ? op.salaryPlanRubPerShift.div(
              op.salaryPlanShiftSeconds && op.salaryPlanShiftSeconds > 0
                ? op.salaryPlanShiftSeconds
                : 28800,
            )
          : null;
      const effMode = step.pricingModeOverride ?? op.pricingMode;

      let stepTime = 0;
      let stepTimeCounted = false;
      let stepCost = new Prisma.Decimal(0);
      let stepCostCounted = false;
      for (const item of items) {
        if (item.qtyPlan <= 0) continue;
        const qty = item.qtyPlan;
        // Время.
        let timeSec: number | null = null;
        if (op.timeNormMode === 'FIXED') {
          timeSec = step.timeNormSecOverride ?? op.timeNormSec ?? null;
        } else {
          timeSec = sizeOvSec.get(item.sizeId) ?? timeBySize.get(item.sizeId) ?? null;
        }
        if (timeSec != null) {
          stepTime += timeSec * qty;
          stepTimeCounted = true;
        } else {
          docWarnings.add('OP_PLAN_INCOMPLETE');
        }
        // Деньги.
        if (effMode === 'SALARY_ONLY') {
          if (salaryPerSec != null && timeSec != null) {
            stepCost = stepCost.add(salaryPerSec.mul(timeSec).mul(qty));
            stepCostCounted = true;
          } else {
            docWarnings.add('OP_PLAN_INCOMPLETE');
          }
        } else if (effMode === 'FIXED') {
          const rate = step.rateOverride ?? op.fixedRate ?? null;
          if (rate != null) {
            stepCost = stepCost.add(rate.mul(qty));
            stepCostCounted = true;
          } else {
            docWarnings.add('OP_PLAN_INCOMPLETE');
          }
        } else if (effMode === 'BY_SIZE') {
          const rate = sizeOvRate.get(item.sizeId) ?? ratesBySize.get(item.sizeId) ?? null;
          if (rate != null) {
            stepCost = stepCost.add(rate.mul(qty));
            stepCostCounted = true;
          } else {
            docWarnings.add('OP_PLAN_INCOMPLETE');
          }
        }
      }
      if (stepTimeCounted) {
        acc.planTimeSec = (acc.planTimeSec ?? 0) + stepTime;
      }
      if (stepCostCounted) {
        acc.planRub = (acc.planRub ?? new Prisma.Decimal(0)).add(stepCost);
      }
      ops.set(op.id, acc);
    }

    // --- ФАКТ по начислениям (на текущий момент) ---
    const entries = await this.prisma.operationEntry.findMany({
      where: {
        passport: { orderId },
        status: { in: FACT_ENTRY_STATUSES },
      },
      select: {
        operationId: true,
        qty: true,
        amount: true,
        status: true,
        operation: { select: { code: true, name: true } },
        passport: {
          select: { color: true, size: { select: { code: true } } },
        },
      },
    });
    for (const e of entries) {
      const acc: OpAcc =
        ops.get(e.operationId) ?? {
          key: e.operationId,
          index: 9000, // операции без шага маршрута — в конце
          code: e.operation.code,
          name: e.operation.name || e.operation.code,
          planQty: null,
          planTimeSec: null,
          planRub: null,
          factQty: 0,
          factRub: new Prisma.Decimal(0),
          factApprovedRub: new Prisma.Decimal(0),
          breakdown: new Map(),
        };
      acc.factQty += e.qty;
      acc.factRub = acc.factRub.add(e.amount);
      if (e.status === 'APPROVED') {
        acc.factApprovedRub = acc.factApprovedRub.add(e.amount);
      }
      const sizeCode = e.passport?.size?.code ?? null;
      const color = e.passport?.color ?? null;
      const bk = `${sizeCode ?? ''}|${color ?? ''}`;
      const b = acc.breakdown.get(bk) ?? {
        sizeCode,
        color,
        qty: 0,
        rub: new Prisma.Decimal(0),
      };
      b.qty += e.qty;
      b.rub = b.rub.add(e.amount);
      acc.breakdown.set(bk, b);
      ops.set(e.operationId, acc);
    }

    const out: OrderProductionOperationRowDto[] = [...ops.values()]
      .map((acc) => {
        const planRub = acc.planRub != null ? this.m(acc.planRub) : null;
        const factRub = this.m(acc.factRub);
        const breakdown: OrderProductionBreakdownDto[] = [...acc.breakdown.values()]
          .map((b) => ({
            sizeCode: b.sizeCode,
            color: b.color,
            planQty:
              b.sizeCode != null
                ? (planQtyBySizeCode.get(b.sizeCode) ?? null)
                : null,
            factQty: String(b.qty),
            factRub: this.m(b.rub).toFixed(2),
          }))
          .sort((a, b) => (a.sizeCode ?? '').localeCompare(b.sizeCode ?? ''));
        return {
          key: acc.key,
          index: acc.index,
          operationCode: acc.code,
          operationName: acc.name,
          planQty: acc.planQty,
          planTimeSec: acc.planTimeSec,
          planRub: planRub != null ? planRub.toFixed(2) : null,
          factQty: acc.factQty,
          factRub: factRub.toFixed(2),
          factApprovedRub: this.m(acc.factApprovedRub).toFixed(2),
          varianceRub:
            planRub != null ? this.m(factRub.sub(planRub)).toFixed(2) : null,
          warnings: [],
          breakdown,
        };
      })
      .sort((a, b) => a.index - b.index || a.operationName.localeCompare(b.operationName));
    return out;
  }
}
