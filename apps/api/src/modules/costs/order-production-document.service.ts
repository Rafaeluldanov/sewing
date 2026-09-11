import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type EntryStatus, type PricingMode } from '@prisma/client';
import type {
  OrderProductionBreakdownDto,
  OrderProductionDocumentDto,
  OrderProductionMaterialRowDto,
  OrderProductionOperationRowDto,
  ProductionDocMaterialPlanSource,
} from '@sewing/shared/order-production-document';
import { normalizeColorOrNull } from '@sewing/shared/colors';
import { getWorkshopNeedKind } from '@sewing/shared/workshop-needs';

import { PrismaService } from '../../prisma/prisma.service.js';
import { erpMaterialFactByNeed } from './erp-material-fact.js';
import { TIRAGE_NEED_WHERE } from '../workshop-needs/workshop-need-scope.js';
import { ACTIVE_CALCULATION_ESTIMATE_WHERE } from '../orders/cost-estimate-scope.js';

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
 *     синтетические строки;
 *   - СТОРОННИЕ УСЛУГИ (решение владельца 10.09.2026): по объёму, отданному
 *     подрядчику (`OrderRouteStep.outsourced` + `outsourcedQty` по
 *     размерам), в план идёт цена размещения вместо своей расценки, а
 *     строка получает метку `outsourced` и расшифровку `outsourcePlanRub`.
 *     Факта по такому объёму не будет — его никто не сканирует, и это
 *     НОРМА, а не недовыпуск. Плановое ВРЕМЯ метка не трогает.
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
        materialsAndHardwareCostPolicy: true,
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
    // Плановое количество по размеру (агрегат Σ по цветам — для заказов
    // без расцветок и как фолбэк).
    const planQtyBySizeCode = new Map<string, number>();
    for (const it of order.items) {
      const code = it.size?.code ?? it.sizeId;
      planQtyBySizeCode.set(
        code,
        (planQtyBySizeCode.get(code) ?? 0) + (it.qtyPlan ?? 0),
      );
    }

    // План по (размер × цвет) из расцветок (`OrderVariantSize`). Для
    // мультирасцветочных заказов `OrderItem` — это агрегат Σ по цветам,
    // поэтому провал операций по конкретному цвету надо сверять с планом
    // именно этой расцветки, а не с суммой по размеру (иначе каждый цвет
    // ложно читается как недовыпуск). Ключ — `размер|нормализованный цвет`,
    // цвет нормализуем тем же `normalizeColor`, что и `Passport.color`.
    const variants = await this.prisma.orderVariant.findMany({
      where: { orderId },
      select: {
        color: true,
        sizes: {
          select: { qtyPlan: true, size: { select: { code: true } } },
        },
      },
    });
    const hasColorways = variants.length > 0;
    const planQtyBySizeColor = new Map<string, number>();
    for (const v of variants) {
      const nc = normalizeColorOrNull(v.color) ?? '';
      for (const s of v.sizes) {
        const code = s.size?.code;
        if (!code) continue;
        const key = `${code}|${nc}`;
        planQtyBySizeColor.set(
          key,
          (planQtyBySizeColor.get(key) ?? 0) + s.qtyPlan,
        );
      }
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
    // Смета — по варианту просчёта: только активный (см.
    // `apps/api/src/modules/orders/cost-estimate-scope.ts`).
    const estimate = await this.prisma.orderCostEstimate.findFirst({
      where: {
        orderId,
        status: 'COMPLETED',
        AND: [ACTIVE_CALCULATION_ESTIMATE_WHERE],
      },
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

    // Давальческое сырьё/фурнитура (`EXCLUDE`): стоимость MATERIAL/HARDWARE
    // (план и факт) не входит в себестоимость/маржу — зеркалит
    // `CostsService`/`OrderCostEstimatesService`/`ProductionCostV2Service`.
    // APPLICATION (нанесение) и OTHER остаются: их платит цех.
    const excludeMatHw =
      (order.materialsAndHardwareCostPolicy ?? 'INCLUDE') === 'EXCLUDE';
    const materials = await this.buildMaterials(
      orderId,
      estimate?.usdRateRub ?? null,
      planRubByNeed,
      excludeMatHw,
      docWarnings,
    );
    const operations = await this.buildOperations(
      orderId,
      order.items,
      planQtyBySizeCode,
      planQtyBySizeColor,
      hasColorways,
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
    // План операций — ПОЛНЫЙ: своя работа + стоимость стороннего размещения
    // (`outsourcePlanRub` внутри строки — только расшифровка «в том числе»,
    // складывать её отдельно нельзя, иначе подряд задвоится). Так же устроен
    // `Order.operationCostPlanRub` — итоги документа и карточка заказа
    // должны сходиться.
    let planOperations = new Prisma.Decimal(0);
    let factOperations = new Prisma.Decimal(0);
    // Стороннее размещение внутри плана: и расшифровка для экрана, и база
    // для честного отклонения — по отданному подрядчику объёму факта в
    // цеху не будет никогда.
    let planOutsource = new Prisma.Decimal(0);
    for (const r of operations) {
      if (r.planRub != null) planOperations = planOperations.add(r.planRub);
      factOperations = factOperations.add(r.factRub);
      if (r.outsourcePlanRub != null) {
        planOutsource = planOutsource.add(r.outsourcePlanRub);
      }
    }

    planMaterials = this.m(planMaterials);
    issuedMaterials = this.m(issuedMaterials);
    receivedMaterials = this.m(receivedMaterials);
    planOperations = this.m(planOperations);
    factOperations = this.m(factOperations);
    planOutsource = this.m(planOutsource);
    const planDirect = this.m(planMaterials.add(planOperations));
    // ⛔ Подряд признаётся в факте ПЛАНОВОЙ суммой. Своего факта у него в
    // цехе нет и не появится: акт подрядчика — документ ERP
    // (`docs/kb/sewing.md §6`), а сканов по отданному объёму не бывает.
    // Без этого слагаемого прямая себестоимость занижена, а МАРЖА
    // завышена ровно на деньги, уплаченные подрядчику.
    const factDirect = this.m(
      issuedMaterials.add(factOperations).add(planOutsource),
    );

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
        planOutsourceRub: planOutsource.toFixed(2),
        // Отклонение — только по СВОЕЙ работе: план за вычетом размещения.
        varianceOperationsRub: this.m(
          factOperations.sub(planOperations.sub(planOutsource)),
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
    excludeMatHw: boolean,
    docWarnings: Set<string>,
  ): Promise<OrderProductionMaterialRowDto[]> {
    // Ключи строк, стоимость которых НЕ зануляется при `EXCLUDE`: строки
    // потребности с kind APPLICATION (нанесение) / OTHER. Всё остальное —
    // MATERIAL/HARDWARE (в т.ч. факт-списания, у которых нет своей строки
    // потребности: MaterialIssue — это всегда ткань/фурнитура, не нанесение).
    const preserveKeys = new Set<string>();
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
        AND: [TIRAGE_NEED_WHERE],
      },
      select: {
        id: true,
        description: true,
        sourceName: true,
        sourceType: true,
        calculationMethod: true,
        materialRole: true,
        unit: true,
        calculatedQty: true,
        purchaseQty: true,
        quotedPrice: true,
        quotedCurrency: true,
        erpManagedAt: true,
        erpUnitPriceRub: true,
      },
    });
    for (const wn of needs) {
      // Классификация — как канонический источник истины EXCLUDE
      // (`OrderCostEstimatesService` пишет line.kind тем же
      // `getWorkshopNeedKind`). MATERIAL/HARDWARE → зануляем при EXCLUDE;
      // APPLICATION/OTHER — сохраняем.
      const kind = getWorkshopNeedKind({
        sourceType: wn.sourceType,
        calculationMethod: wn.calculationMethod,
        materialRole: wn.materialRole,
      });
      if (kind === 'APPLICATION' || kind === 'OTHER') preserveKeys.add(wn.id);
      // Деньги плана: из сметы, иначе «к закупке» × цена (RUB).
      //
      // ⛔ Количество для ДЕНЕГ — `purchaseQty ?? calculatedQty`, то же, что берут смета
      // (`OrderCostEstimatesService`) и сводка себестоимости (`production-cost-v2`). Раньше
      // fallback считал по `calculatedQty`, и документ противоречил смете на тех же данных:
      // как только закупщик задавал «к закупке» руками, план в деньгах улетал.
      // Прод-прецедент 11.09.2026, заказ ФС-000003: «Печать лекал» заведена в спецификации как
      // 1 шт НА ИЗДЕЛИЕ (расчёт дал 525 шт), закупщик поставил «к закупке» 1 — услуга разовая, —
      // а план показал 525 × 4 460 = 2 341 500 ₽ вместо 4 460 ₽.
      //
      // `planQty` остаётся РАСЧЁТНЫМ: это плановый расход, и сравнивают его с «выдано». Деньги же
      // отвечают на другой вопрос — во сколько заказ обойдётся, — и там решает закупщик.
      const planQty = wn.purchaseQty ?? wn.calculatedQty;
      let planRub: Prisma.Decimal | null = null;
      let planSource: ProductionDocMaterialPlanSource = 'NONE';
      const fromEstimate = planRubByNeed.get(wn.id);
      if (fromEstimate != null) {
        planRub = fromEstimate;
        planSource = 'COST_ESTIMATE';
      } else if (wn.erpManagedAt && wn.erpUnitPriceRub) {
        // Материал под ERP — цена её заказа поставщику (факт), рубли.
        planRub = new Prisma.Decimal(planQty).mul(wn.erpUnitPriceRub);
        planSource = 'WORKSHOP_NEED';
      } else if (wn.quotedPrice != null) {
        if ((wn.quotedCurrency ?? 'RUB') === 'RUB') {
          planRub = new Prisma.Decimal(planQty).mul(wn.quotedPrice);
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

    // 2.1. Факт «списано» по материалам под ERP — её списание по факту выпуска (шаг 6
    // «тёмной лестницы»). У таких потребностей своего документа расхода в цехе нет:
    // автосписание кроя строк под ERP не создаёт, поэтому источники не пересекаются.
    // Количество — в единице цеха, сумма — та, что ERP реально сняла с партий рулона.
    const erpFacts = await erpMaterialFactByNeed(this.prisma, orderId);
    for (const fact of erpFacts.values()) {
      const acc = ensure(fact.workshopNeedId, {
        name: fact.description,
        unit: fact.unit ?? '',
        materialRole: null,
      });
      acc.issuedQty = acc.issuedQty.add(fact.qty);
      acc.issuedRub = acc.issuedRub.add(fact.rub);
      for (const part of fact.breakdown) {
        const bk = `${part.sizeCode ?? ''}|${part.color ?? ''}`;
        const b = acc.breakdown.get(bk) ?? {
          sizeCode: part.sizeCode,
          color: part.color,
          qty: new Prisma.Decimal(0),
          rub: new Prisma.Decimal(0),
        };
        b.qty = b.qty.add(part.qty);
        b.rub = b.rub.add(part.rub);
        acc.breakdown.set(bk, b);
      }
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
    const ZERO = new Prisma.Decimal(0);
    for (const acc of rows.values()) {
      // Давальческое: зануляем ДЕНЬГИ (план/факт/приёмка) строки, но
      // сохраняем КОЛИЧЕСТВА (полезны для учёта расхода сырья заказчика).
      // Нанесение/прочее не трогаем: либо ключ строки — в preserveKeys
      // (потребность активного варианта), либо её роль классифицируется
      // как APPLICATION (факт-строка, чья потребность отменена/в неактивном
      // варианте и потому не попала в preserveKeys).
      const zeroCost =
        excludeMatHw &&
        !preserveKeys.has(acc.key) &&
        getWorkshopNeedKind({ materialRole: acc.materialRole }) !==
          'APPLICATION';
      const issuedRub = zeroCost ? ZERO : this.m(acc.issuedRub);
      const receivedRub = zeroCost ? ZERO : this.m(acc.receivedRub);
      const planRub =
        acc.planRub != null ? (zeroCost ? ZERO : this.m(acc.planRub)) : null;
      const breakdown: OrderProductionBreakdownDto[] = [...acc.breakdown.values()]
        .map((b) => ({
          sizeCode: b.sizeCode,
          color: b.color,
          planQty: null,
          factQty: this.q(b.qty).toFixed(4),
          factRub: (zeroCost ? ZERO : this.m(b.rub)).toFixed(2),
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
        receivedRub: receivedRub.toFixed(2),
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
  /**
   * План для строки разреза операции по (размер × цвет). Для
   * мультирасцветочных заказов берём план конкретной расцветки
   * (`OrderVariantSize`), сверенный по нормализованному цвету; фолбэк на
   * размерный агрегат — когда расцветок нет или цвет строки не совпал ни с
   * одной расцветкой (данные-легаси). Иначе провал по цвету сверялся бы с
   * суммой плана по всем цветам размера и ложно показывал недовыпуск.
   */
  private resolveBreakdownPlanQty(
    sizeCode: string | null,
    color: string | null,
    planQtyBySizeCode: Map<string, number>,
    planQtyBySizeColor: Map<string, number>,
    hasColorways: boolean,
  ): number | null {
    if (sizeCode == null) return null;
    if (hasColorways) {
      const nc = normalizeColorOrNull(color);
      if (nc != null) {
        const perColor = planQtyBySizeColor.get(`${sizeCode}|${nc}`);
        if (perColor != null) return perColor;
      }
    }
    return planQtyBySizeCode.get(sizeCode) ?? null;
  }

  private async buildOperations(
    orderId: string,
    items: { sizeId: string; qtyPlan: number; size: { code: string } | null }[],
    planQtyBySizeCode: Map<string, number>,
    planQtyBySizeColor: Map<string, number>,
    hasColorways: boolean,
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
        // СТОРОННИЕ УСЛУГИ: подряд назначается на шаге ЗАКАЗА (снимок), а
        // объём — по размерам (`outsourcedQty`). По отданному объёму в план
        // идёт цена размещения вместо своей расценки — см. плановый цикл ниже.
        outsourced: true,
        outsourcePriceRub: true,
        sizeOverrides: {
          select: { sizeId: true, rate: true, seconds: true, outsourcedQty: true },
        },
        operation: { select: opSelect },
      },
    });

    type Step = {
      index: number;
      rateOverride: Prisma.Decimal | null;
      timeNormSecOverride: number | null;
      pricingModeOverride: PricingMode | null;
      outsourced: boolean;
      outsourcePriceRub: Prisma.Decimal | null;
      sizeOverrides: {
        sizeId: string;
        rate: Prisma.Decimal | null;
        seconds: number | null;
        outsourcedQty: number | null;
      }[];
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
          // Подряда у шаблона маршрута нет и быть не может: «делаем на
          // стороне» — решение по КОНКРЕТНОМУ тиражу, оно живёт только в
          // снимке заказа (`OrderRouteStep.outsourced`). Пока снимка нет,
          // план считается целиком своей расценкой — как и раньше.
          outsourced: false,
          outsourcePriceRub: null,
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
      /**
       * СТОРОННИЕ УСЛУГИ: хотя бы один шаг строки помечен «делаем на
       * стороне». Флаг, а не счётчик: `ops` ключуется `op.id`, и если
       * операция стоит в маршруте дважды (например, ВТО до и после
       * пришива), обе строки схлопываются в одну — «есть подряд» верно
       * и для такой склейки.
       */
      outsourced: boolean;
      /**
       * Сколько из `planRub` — стоимость стороннего размещения
       * (`outsourcePriceRub × отданное количество`). `null` — по строке
       * ничего не размещали: план целиком свой. Копится отдельно от
       * `planRub`, потому что `planRub` остаётся ПОЛНЫМ планом операции
       * (своё + размещение), а UI показывает расшифровку «в том числе».
       */
      outsourceRub: Prisma.Decimal | null;
      /** Строка-замена (PF3): факт замещающей операции + суммарный план
       *  замещённых ею плановых шагов. */
      substituteFolded?: boolean;
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
        outsourced: false,
        outsourceRub: null,
      };

      const ratesBySize = new Map(op.ratesBySize.map((r) => [r.sizeId, r.rate]));
      const timeBySize = new Map(
        op.timeNormsBySize.map((t) => [t.sizeId, t.seconds]),
      );
      const sizeOvRate = new Map<string, Prisma.Decimal>();
      const sizeOvSec = new Map<string, number>();
      // Остаток объёма, отданного подрядчику, по размерам: его «раздаём» по
      // строкам плана ниже (размер может встретиться в нескольких items —
      // это разные изделия одного заказа).
      const outQtyLeftBySize = new Map<string, number>();
      for (const o of step.sizeOverrides) {
        if (o.rate != null) sizeOvRate.set(o.sizeId, o.rate);
        if (o.seconds != null) sizeOvSec.set(o.sizeId, o.seconds);
        if (o.outsourcedQty != null) {
          outQtyLeftBySize.set(o.sizeId, o.outsourcedQty);
        }
      }
      // Подряд отмечен, но объём по размерам не расписан ⇒ на стороне ВЕСЬ
      // тираж операции (правило расчёта).
      const outsourceWholeStep = step.outsourced && outQtyLeftBySize.size === 0;
      // Метку строки ставим по самому шагу, а не по посчитанному объёму:
      // «делаем на стороне» — решение менеджера, и оно должно быть видно в
      // документе, даже если размеры в переопределениях разошлись с планом.
      if (step.outsourced) acc.outsourced = true;
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
      let stepOutsource = new Prisma.Decimal(0);
      let stepOutsourceCounted = false;
      for (const item of items) {
        if (item.qtyPlan <= 0) continue;
        const qty = item.qtyPlan;
        // СТОРОННИЕ УСЛУГИ: делим плановое количество строки на «своё» и
        // «отданное». Остаток подряда по размеру расходуем жадно, по
        // порядку items, и никогда больше, чем есть в самой строке;
        // размеры без `outsourcedQty` подрядчику не отдавались.
        let outQty = 0;
        if (step.outsourced) {
          if (outsourceWholeStep) {
            outQty = qty;
          } else {
            // `Math.max(0, …)` — защита от отрицательного объёма в БД
            // (через API он невозможен, но ручная правка данных иначе
            // раздула бы СВОЮ часть плана сверх тиража).
            const left = Math.max(0, outQtyLeftBySize.get(item.sizeId) ?? 0);
            outQty = Math.min(qty, left);
            if (outQty > 0) outQtyLeftBySize.set(item.sizeId, left - outQty);
          }
        }
        const ownQty = qty - outQty;
        // Время.
        let timeSec: number | null = null;
        if (op.timeNormMode === 'FIXED') {
          timeSec = step.timeNormSecOverride ?? op.timeNormSec ?? null;
        } else {
          timeSec = sizeOvSec.get(item.sizeId) ?? timeBySize.get(item.sizeId) ?? null;
        }
        // Плановое время считаем по ПОЛНОМУ количеству, включая отданное
        // подрядчику: метка «на стороне» — решение владельца ТОЛЬКО про
        // деньги, узкое место и загрузку цеха она не двигает.
        if (timeSec != null) {
          stepTime += timeSec * qty;
          stepTimeCounted = true;
        } else {
          docWarnings.add('OP_PLAN_INCOMPLETE');
        }
        // Деньги: своя расценка — только на то, что цех делает сам. Ставку
        // ищем лишь при `ownQty > 0`: у полностью отданной операции своей
        // ставки может не быть вовсе, и OP_PLAN_INCOMPLETE звал бы завести
        // ставку, которая этому заказу не нужна.
        if (ownQty > 0) {
          if (effMode === 'SALARY_ONLY') {
            if (salaryPerSec != null && timeSec != null) {
              stepCost = stepCost.add(salaryPerSec.mul(timeSec).mul(ownQty));
              stepCostCounted = true;
            } else {
              docWarnings.add('OP_PLAN_INCOMPLETE');
            }
          } else if (effMode === 'FIXED') {
            const rate = step.rateOverride ?? op.fixedRate ?? null;
            if (rate != null) {
              stepCost = stepCost.add(rate.mul(ownQty));
              stepCostCounted = true;
            } else {
              docWarnings.add('OP_PLAN_INCOMPLETE');
            }
          } else if (effMode === 'BY_SIZE') {
            const rate = sizeOvRate.get(item.sizeId) ?? ratesBySize.get(item.sizeId) ?? null;
            if (rate != null) {
              stepCost = stepCost.add(rate.mul(ownQty));
              stepCostCounted = true;
            } else {
              docWarnings.add('OP_PLAN_INCOMPLETE');
            }
          }
        }
        // Отданный объём: вместо своей расценки в план идёт стоимость
        // размещения (цена за ОДНО изделие × штуки). Цена не задана —
        // размещение считается как 0, но строка всё равно помечается как
        // «есть подряд»: сигнал «заведите цену» даёт плановый контур заказа
        // (`operationPlanWarnings`), а документу подряд — норма, не проблема.
        if (outQty > 0) {
          if (step.outsourcePriceRub != null) {
            const placedRub = step.outsourcePriceRub.mul(outQty);
            stepCost = stepCost.add(placedRub);
            stepCostCounted = true;
            stepOutsource = stepOutsource.add(placedRub);
          }
          stepOutsourceCounted = true;
        }
      }
      if (stepTimeCounted) {
        acc.planTimeSec = (acc.planTimeSec ?? 0) + stepTime;
      }
      if (stepCostCounted) {
        acc.planRub = (acc.planRub ?? new Prisma.Decimal(0)).add(stepCost);
      }
      if (stepOutsourceCounted) {
        // Складываем, а не присваиваем: одна и та же операция может стоять
        // в маршруте несколькими шагами (ключ строки — `op.id`), и подряд
        // мог быть отдан на каждом из них.
        acc.outsourceRub = (acc.outsourceRub ?? new Prisma.Decimal(0)).add(
          stepOutsource,
        );
      }
      ops.set(op.id, acc);
    }

    // Множество op.id плановых шагов — фиксируем ДО того, как факт-цикл
    // добавит строки-сироты. Нужно для сворачивания замещающих операций.
    const planStepOpIds = new Set(ops.keys());

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
          // Строка без планового шага: подряд назначается только на шаге
          // маршрута, поэтому у «сироты» его быть не может. Если строка
          // окажется замещающей операцией — метку и сумму размещения ей
          // перенесёт сворачивание PF3 ниже, вместе с планом.
          outsourced: false,
          outsourceRub: null,
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

    // --- Замещающие операции (PF3): свернуть факт замены в ОДНУ строку ---
    // Факт закрывается на замещающей операции S (её operationId), а не на
    // плановом шаге, который она замещает (`OperationSubstitution`), поэтому
    // S уходила в «сироту» (index 9000, без плана), а плановый шаг показывал
    // ложный «100% недовыпуск». Собираем ОДНУ строку S с СУММАРНЫМ планом
    // замещённых шагов (у которых нет своего прямого факта) и убираем их
    // отдельные строки. Σ planRub / Σ factRub инвариантны: план лишь
    // переносится на строку S, а факт замены уже на ней (ЗП пишет одну
    // нетто-запись на S, см. EarningsService).
    const orphanIds = [...ops.keys()].filter((id) => !planStepOpIds.has(id));
    if (orphanIds.length > 0) {
      const subs = await this.prisma.operationSubstitution.findMany({
        where: { substituteOpId: { in: orphanIds } },
        select: { substituteOpId: true, satisfiesOpId: true },
      });
      const satisfiesBySub = new Map<string, string[]>();
      for (const s of subs) {
        const arr = satisfiesBySub.get(s.substituteOpId) ?? [];
        arr.push(s.satisfiesOpId);
        satisfiesBySub.set(s.substituteOpId, arr);
      }
      for (const subId of orphanIds) {
        const subAcc = ops.get(subId);
        if (!subAcc) continue;
        // Замещаемые ПЛАНОВЫЕ шаги, у которых нет своего прямого факта
        // (иначе строку шага не трогаем — по ней делали напрямую).
        const merged = (satisfiesBySub.get(subId) ?? [])
          .map((sid) => ops.get(sid))
          .filter(
            (p): p is OpAcc =>
              p != null && planStepOpIds.has(p.key) && p.factQty === 0,
          );
        if (merged.length === 0) continue;
        let planRub: Prisma.Decimal | null = null;
        let planTimeSec: number | null = null;
        // Метка подряда и стоимость размещения — часть ПЛАНА замещённых
        // шагов, поэтому переезжают на строку-замену вместе с ним: иначе
        // расшифровка «в том числе размещение» потерялась бы, а `planRub`
        // остался бы с деньгами подрядчика без объяснения, откуда они.
        let outsourceRub: Prisma.Decimal | null = null;
        let outsourced = false;
        for (const p of merged) {
          if (p.planRub != null)
            planRub = (planRub ?? new Prisma.Decimal(0)).add(p.planRub);
          if (p.planTimeSec != null)
            planTimeSec = (planTimeSec ?? 0) + p.planTimeSec;
          if (p.outsourceRub != null)
            outsourceRub = (outsourceRub ?? new Prisma.Decimal(0)).add(
              p.outsourceRub,
            );
          if (p.outsourced) outsourced = true;
          ops.delete(p.key);
        }
        subAcc.planRub = planRub;
        subAcc.planTimeSec = planTimeSec;
        subAcc.outsourceRub = outsourceRub;
        subAcc.outsourced = outsourced;
        subAcc.planQty = qtyPlanTotal > 0 ? qtyPlanTotal : null;
        // Встаём на место самого раннего замещённого шага (не в конец).
        subAcc.index = Math.min(...merged.map((p) => p.index));
        subAcc.name = `${subAcc.name} (замещает ${merged
          .map((p) => p.code)
          .join(', ')})`;
        subAcc.substituteFolded = true;
      }
    }

    const out: OrderProductionOperationRowDto[] = [...ops.values()]
      .map((acc) => {
        const planRub = acc.planRub != null ? this.m(acc.planRub) : null;
        const factRub = this.m(acc.factRub);
        // «В том числе размещение» — расшифровка внутри `planRub`, а не
        // отдельное слагаемое: план операции остаётся полным (своё +
        // подряд), чтобы итоги документа и `Order.operationCostPlanRub`
        // сходились копейка в копейку.
        const outsourcePlanRub =
          acc.outsourceRub != null ? this.m(acc.outsourceRub) : null;
        const breakdown: OrderProductionBreakdownDto[] = [...acc.breakdown.values()]
          .map((b) => ({
            sizeCode: b.sizeCode,
            color: b.color,
            planQty: this.resolveBreakdownPlanQty(
              b.sizeCode,
              b.color,
              planQtyBySizeCode,
              planQtyBySizeColor,
              hasColorways,
            ),
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
          // Метка «делаем на стороне»: по отданному объёму факта не будет —
          // его никто не сканирует, и это НОРМА, а не недовыпуск. Поэтому
          // отдельным полем, а не кодом в `warnings` (там UI рисует ⚠).
          outsourced: acc.outsourced,
          outsourcePlanRub:
            outsourcePlanRub != null ? outsourcePlanRub.toFixed(2) : null,
          // Отклонение строки — от СВОЕЙ части плана (план за вычетом
          // размещения): по отданному подрядчику объёму скана не будет, и
          // сравнивать факт цеха с деньгами подрядчика бессмысленно —
          // строка вечно показывала бы «недовыпуск» на всю сумму подряда.
          varianceRub:
            planRub != null
              ? this.m(
                  factRub.sub(
                    outsourcePlanRub != null
                      ? planRub.sub(outsourcePlanRub)
                      : planRub,
                  ),
                ).toFixed(2)
              : null,
          // Факт без плана и без легальной замены = работа мимо
          // маршрута заказа. Считаем ЗДЕСЬ, а не на месте `index: 9000`:
          // там в «сиротах» лежат и замещающие операции, которые сворачиваются
          // законно чуть ниже (PF3), и пометить их как нарушение было бы
          // ложной тревогой.
          warnings: [
            ...(acc.substituteFolded ? ['SUBSTITUTE_FOLDED'] : []),
            ...(!planStepOpIds.has(acc.key) && !acc.substituteFolded
              ? ['WORK_OUTSIDE_ROUTE']
              : []),
          ],
          breakdown,
        };
      })
      .sort((a, b) => a.index - b.index || a.operationName.localeCompare(b.operationName));
    return out;
  }
}
