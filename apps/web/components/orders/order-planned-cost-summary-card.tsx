/**
 * `OrderPlannedCostSummaryCard` — компактный блок «Плановая
 * себестоимость» в карточке заказа `/admin/orders/[id]`, секция
 * «4. Производство» (рядом с «План операций»).
 *
 * Зачем:
 *   - Менеджер хочет видеть «материалы + операции» и «за 1
 *     изделие» в одном месте, не переключаясь между блоками
 *     «Потребность цеха», «Себестоимость» и «План операций».
 *   - Это сводный visual-only блок: в БД ничего не пишет, расчёт
 *     `WorkshopNeed` и `OrderCostEstimate.completeCalculation` не
 *     меняем.
 *
 * Источники данных (см. `apps/web/components/orders/order-cost-estimate-card.tsx`,
 * `apps/web/lib/workshop-needs-api.ts`,
 * `packages/shared/src/order-cost-estimates.ts`):
 *
 *   1. `order.currentCostEstimate`  — приоритетный источник; это
 *      snapshot завершённого расчёта (`OrderCostEstimate`).
 *      Группируем `lines` по `kind` (`MATERIAL`/`HARDWARE`/
 *      `APPLICATION`/`OTHER`). LABOR в `OrderCostEstimateLine.kind`
 *      на этом этапе не добавляется — операции тянем отдельно из
 *      `order.operationCostPlanRub` (см. ТЗ §6 «Операции»).
 *   2. иначе — текущие `WorkshopNeed` через
 *      `getOrderWorkshopNeeds(order.id)`. Группируем по
 *      `getWorkshopNeedKind(needs)` и считаем `purchaseQty ??
 *      calculatedQty × quotedPrice`. Только RUB-строки попадают в
 *      итог; USD-строки выводятся отдельным warning, поскольку
 *      курс задаётся вручную в `completeCalculation` и нам его
 *      пока нет.
 *
 * Операции (`order.operationCostPlanRub`):
 *   - всегда показываются как отдельная строка;
 *   - бэйдж «Требует пересчёта», если `order.operationPlanIsStale`;
 *   - «—» если `null` (план ещё не считался);
 *   - «За 1 изделие» = `operationCostPlanRub / order.qtyPlanTotal`
 *     (если `qtyPlanTotal > 0`).
 *
 * Materials per unit (обязательное требование ТЗ §3):
 *   - `materialsUnitRub = materialsRub / qtyPlanTotal`;
 *   - использует только kind `MATERIAL`, без HARDWARE/APPLICATION/
 *     OPERATIONS — менеджер хочет видеть «во сколько обходится
 *     ткань на одно изделие».
 *
 * Это server component, который сам подгружает workshopNeeds, если
 * `currentCostEstimate` нет. Если есть — лишний fetch не делаем.
 *
 * Backend / Prisma / API не менялись.
 */
import { AlertTriangle, Wallet } from 'lucide-react';
import {
  ORDER_COST_ESTIMATE_LINE_KIND_LABELS,
  type OrderCostEstimateDto,
  type OrderCostEstimateLineKind,
} from '@sewing/shared/order-cost-estimates';
import {
  getWorkshopNeedKind,
  type WorkshopNeedKind,
  type WorkshopNeedListItemDto,
} from '@sewing/shared/workshop-needs';
import type { OrderDetailDto } from '@sewing/shared/orders';
import { ApiRequestError } from '@/lib/api';
import { getOrderWorkshopNeeds } from '@/lib/workshop-needs-api';

interface Props {
  order: OrderDetailDto;
  /**
   * Если родитель уже подгрузил список потребностей (например, для
   * другого блока на той же странице), его можно прокинуть, чтобы не
   * делать второй fetch. Если не передан и `currentCostEstimate`
   * нет — компонент сам сходит в `/api/orders/:id/workshop-needs`.
   */
  workshopNeeds?: WorkshopNeedListItemDto[];
}

/** Источник, на основе которого построена сводка. */
type CostSource = 'estimate' | 'workshopNeeds' | 'empty';

interface SummaryBuckets {
  materialsRub: number;
  hardwareRub: number;
  applicationRub: number;
  otherRub: number;
  /** Суммы по строкам в RUB — одна и та же логика для estimate / needs. */
  hasUsdLines: boolean;
}

const RUB_FORMATTER = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 2,
});

function fmtRub(v: number | string | null | undefined): string {
  if (v == null) return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  return RUB_FORMATTER.format(n);
}

function fmtRubPerUnit(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${RUB_FORMATTER.format(v)} / шт`;
}

/**
 * Считаем суммы по kind из завершённого расчёта.
 * `OrderCostEstimateLine.lineTotalRub` уже посчитан backend-ом
 * (включая USD→RUB по `usdRateRub`), поэтому здесь USD warning
 * никогда не возникает — расчёт зафиксирован в рублях.
 */
function bucketsFromEstimate(estimate: OrderCostEstimateDto): SummaryBuckets {
  const buckets: SummaryBuckets = {
    materialsRub: 0,
    hardwareRub: 0,
    applicationRub: 0,
    otherRub: 0,
    hasUsdLines: false,
  };
  for (const line of estimate.lines) {
    const kind = (line.kind as OrderCostEstimateLineKind) ?? 'OTHER';
    const total = Number(line.lineTotalRub) || 0;
    addToBucket(buckets, mapEstimateKind(kind), total);
  }
  return buckets;
}

function mapEstimateKind(
  kind: OrderCostEstimateLineKind | string,
): WorkshopNeedKind {
  if (
    kind === 'MATERIAL' ||
    kind === 'HARDWARE' ||
    kind === 'APPLICATION' ||
    kind === 'OTHER'
  ) {
    return kind;
  }
  return 'OTHER';
}

function addToBucket(
  buckets: SummaryBuckets,
  kind: WorkshopNeedKind,
  amountRub: number,
): void {
  if (!Number.isFinite(amountRub)) return;
  switch (kind) {
    case 'MATERIAL':
      buckets.materialsRub += amountRub;
      break;
    case 'HARDWARE':
      buckets.hardwareRub += amountRub;
      break;
    case 'APPLICATION':
      buckets.applicationRub += amountRub;
      break;
    case 'OTHER':
    default:
      buckets.otherRub += amountRub;
      break;
  }
}

/**
 * Считаем суммы по kind из текущих `WorkshopNeed`. До завершения
 * расчёта это «прикидка», поэтому:
 *   - используем `purchaseQty ?? calculatedQty` как финальное
 *     количество (это та же логика, что у backend в
 *     `OrderCostEstimatesService.completeCalculation` — см.
 *     `apps/api/src/modules/orders/order-cost-estimates.service.ts`);
 *   - умножаем на `quotedPrice` только для RUB-строк;
 *   - USD-строки помечаем флагом, чтобы UI вывел warning «итог
 *     в рублях будет доступен после ввода курса».
 *
 * Строки с пустой ценой / нулевой ценой / отменённые сознательно
 * пропускаем (нечего класть в итог).
 */
function bucketsFromWorkshopNeeds(
  needs: WorkshopNeedListItemDto[],
): SummaryBuckets {
  const buckets: SummaryBuckets = {
    materialsRub: 0,
    hardwareRub: 0,
    applicationRub: 0,
    otherRub: 0,
    hasUsdLines: false,
  };
  for (const need of needs) {
    if (need.status === 'CANCELLED') continue;
    const priceRaw = need.quotedPrice;
    if (priceRaw == null || priceRaw === '') continue;
    const price = Number(priceRaw);
    if (!Number.isFinite(price) || price <= 0) continue;
    const qtyRaw = need.purchaseQty ?? need.calculatedQty;
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const total = price * qty;

    const currency = (need.quotedCurrency ?? 'RUB') as string;
    if (currency === 'USD') {
      buckets.hasUsdLines = true;
      continue;
    }
    if (currency !== 'RUB') {
      // Чужая валюта (не должна попадать после сужения до
      // MoneyCurrencySchema, но защищаемся): не кладём в итог,
      // но и USD-warning не показываем — это редкий legacy-кейс.
      continue;
    }

    // Роль материала — ГЛАВНЫЙ признак классификации (см.
    // `getWorkshopNeedKind`): по ней фурнитура отделяется от тканей.
    // Без неё молнии и люверсы уезжали в «Материалы» и «Прочее», строка
    // «Фурнитура» показывала ноль, а «материалы за изделие» — завышенное
    // число. Передаём ровно как соседний `resolveMaterialSection`.
    const kind = getWorkshopNeedKind({
      sourceType: need.sourceType,
      calculationMethod: need.calculationMethod,
      materialRole: need.materialRole ?? undefined,
    });
    addToBucket(buckets, kind, total);
  }
  return buckets;
}

function bucketsAreEmpty(b: SummaryBuckets): boolean {
  return (
    b.materialsRub === 0 &&
    b.hardwareRub === 0 &&
    b.applicationRub === 0 &&
    b.otherRub === 0
  );
}

export async function OrderPlannedCostSummaryCard({
  order,
  workshopNeeds,
}: Props) {
  const estimate = order.currentCostEstimate ?? null;

  // Если расчёт зафиксирован — берём snapshot. Иначе подгружаем
  // потребности «как есть» (preliminary). При ошибке загрузки UI
  // не валится: показываем сообщение и операции (которые уже в DTO).
  let buckets: SummaryBuckets;
  let source: CostSource;
  let needsLoadError: string | null = null;
  if (estimate) {
    buckets = bucketsFromEstimate(estimate);
    source = 'estimate';
  } else {
    let needs: WorkshopNeedListItemDto[] | null = workshopNeeds ?? null;
    if (!needs) {
      try {
        // Скоуп TIRAGE: плановая себестоимость — про тираж, образец
        // в неё не входит (так же считает и смета на бэке).
        needs = await getOrderWorkshopNeeds(order.id, {
          calculationScope: 'TIRAGE',
        });
      } catch (e) {
        needs = [];
        needsLoadError =
          e instanceof ApiRequestError
            ? `Не удалось загрузить потребность цеха: ${e.message}`
            : 'Не удалось загрузить потребность цеха.';
      }
    }
    buckets = bucketsFromWorkshopNeeds(needs);
    // Ручные строки логистики («Добавить поле» в таблице «Операции»)
    // потребностью цеха не являются, но в себестоимость входят —
    // backend заводит их в смету позицией «Прочее». Пока сметы нет,
    // добавляем их здесь, иначе прикидка занижена ровно на логистику.
    // В ветке `estimate` этого делать НЕ надо: там они уже в `lines`.
    for (const line of order.logisticsLines ?? []) {
      const cost = Number(line.costRub);
      if (Number.isFinite(cost) && cost > 0) {
        addToBucket(buckets, 'OTHER', cost);
      }
    }
    source = bucketsAreEmpty(buckets) && !buckets.hasUsdLines
      ? 'empty'
      : 'workshopNeeds';
  }

  // Операции тянем из snapshot-полей заказа, без зависимости от
  // источника (estimate / needs). LABOR в `OrderCostEstimateLine.kind`
  // на этом этапе не добавляется — это namingly визуальная сводка.
  const operationsRubRaw = order.operationCostPlanRub ?? null;
  const operationsRub =
    operationsRubRaw == null ? null : Number(operationsRubRaw);
  const operationsRubResolved =
    operationsRub != null && Number.isFinite(operationsRub)
      ? operationsRub
      : null;
  const isStaleOps = order.operationPlanIsStale === true;

  const totalQty = order.qtyPlanTotal;
  const safeUnit = (v: number | null) =>
    v != null && totalQty > 0 ? v / totalQty : null;

  const materialsUnit = safeUnit(buckets.materialsRub);
  const hardwareUnit = safeUnit(buckets.hardwareRub);
  const applicationUnit = safeUnit(buckets.applicationRub);
  const otherUnit = safeUnit(buckets.otherRub);
  const operationsUnit = safeUnit(operationsRubResolved);

  // Упрощённый MVP давальческого сырья: при политике «не учитывать»
  // backend исключает строки MATERIAL / HARDWARE из
  // `OrderCostEstimate.totalCostRub`, но САМИ СТРОКИ в смете
  // оставляет. Карточка складывала их обратно и показывала итог
  // больше зафиксированной себестоимости заказа — на всю стоимость
  // давальческого сырья. Суммы по секциям при этом оставляем на
  // экране: менеджеру всё равно надо видеть, сколько материала нужно.
  const isMaterialsExcluded =
    (order.materialsAndHardwareCostPolicy ?? 'INCLUDE') === 'EXCLUDE';

  // Итог: материалы + фурнитура + нанесение + прочее + операции.
  // Если операции `null` — не подмешиваем 0, иначе менеджер увидит
  // фейково низкий total. Сам total отдаём `null`, если нет ни
  // одной положительной составляющей.
  const componentsRub = [
    ...(isMaterialsExcluded
      ? []
      : [buckets.materialsRub, buckets.hardwareRub]),
    buckets.applicationRub,
    buckets.otherRub,
    operationsRubResolved,
  ].filter((v): v is number => v != null);
  const hasAnyAmount = componentsRub.some((v) => v > 0);
  const totalRub = hasAnyAmount
    ? componentsRub.reduce((acc, v) => acc + v, 0)
    : null;
  const totalUnit = totalRub != null ? safeUnit(totalRub) : null;

  const showOtherRow = buckets.otherRub > 0;

  const hint =
    source === 'estimate'
      ? 'По завершённому расчёту'
      : source === 'workshopNeeds'
        ? 'Предварительно по заполненным ценам потребности'
        : 'Заполните цены в потребности цеха';

  return (
    <div
      className="order-planned-cost-card"
      data-testid="order-planned-cost-summary"
      data-source={source}
    >
      <div className="order-planned-cost-card__head">
        <div className="order-planned-cost-card__head-icon" aria-hidden>
          <Wallet size={16} strokeWidth={1.7} />
        </div>
        <div className="order-planned-cost-card__head-text">
          <div className="order-planned-cost-card__title">
            Плановая себестоимость
          </div>
          <div className="order-planned-cost-card__hint admin-muted">
            {hint}
          </div>
        </div>
      </div>

      {needsLoadError && (
        <div
          className="order-planned-cost-card__warning"
          role="alert"
          data-testid="order-planned-cost-summary-needs-error"
        >
          <AlertTriangle size={14} strokeWidth={1.7} aria-hidden />
          <span>{needsLoadError}</span>
        </div>
      )}

      {source === 'empty' && !needsLoadError ? (
        <div
          className="order-planned-cost-card__empty admin-muted"
          data-testid="order-planned-cost-summary-empty"
        >
          Нет заполненных цен по потребности.
        </div>
      ) : (
        <dl className="order-planned-cost-card__rows">
          <Row
            label={ORDER_COST_ESTIMATE_LINE_KIND_LABELS.MATERIAL}
            value={fmtRub(buckets.materialsRub || null)}
          />
          <Row
            label="Материалы за 1 изделие"
            muted
            value={fmtRubPerUnit(materialsUnit)}
            testId="order-planned-cost-summary-materials-unit"
          />
          <Row
            label={ORDER_COST_ESTIMATE_LINE_KIND_LABELS.HARDWARE}
            value={fmtRub(buckets.hardwareRub || null)}
          />
          {hardwareUnit != null && (
            <Row
              label="Фурнитура за 1 изделие"
              muted
              value={fmtRubPerUnit(hardwareUnit)}
            />
          )}
          <Row
            label={ORDER_COST_ESTIMATE_LINE_KIND_LABELS.APPLICATION}
            value={fmtRub(buckets.applicationRub || null)}
          />
          {applicationUnit != null && (
            <Row
              label="Нанесение за 1 изделие"
              muted
              value={fmtRubPerUnit(applicationUnit)}
            />
          )}
          {showOtherRow && (
            <>
              <Row
                label={ORDER_COST_ESTIMATE_LINE_KIND_LABELS.OTHER}
                value={fmtRub(buckets.otherRub)}
              />
              {otherUnit != null && (
                <Row
                  label="Прочее за 1 изделие"
                  muted
                  value={fmtRubPerUnit(otherUnit)}
                />
              )}
            </>
          )}
          <Row
            label={
              <span className="order-planned-cost-card__ops-label">
                Операции
                {isStaleOps && (
                  <span
                    className="order-planned-cost-card__stale-badge"
                    data-testid="order-planned-cost-summary-ops-stale"
                    title={
                      order.operationPlanStaleReason ??
                      'Источники плана операций изменялись после расчёта'
                    }
                  >
                    Требует пересчёта
                  </span>
                )}
              </span>
            }
            value={fmtRub(operationsRubResolved)}
            testId="order-planned-cost-summary-operations"
          />
          <Row
            label="Операции за 1 изделие"
            muted
            value={fmtRubPerUnit(operationsUnit)}
            testId="order-planned-cost-summary-operations-unit"
          />
          <Row
            label="Итого"
            total
            value={fmtRub(totalRub)}
            testId="order-planned-cost-summary-total"
          />
          <Row
            label="Итого за 1 изделие"
            total
            value={fmtRubPerUnit(totalUnit)}
            testId="order-planned-cost-summary-total-unit"
          />
        </dl>
      )}

      {buckets.hasUsdLines && (
        <div
          className="order-planned-cost-card__warning"
          role="status"
          data-testid="order-planned-cost-summary-usd-warning"
        >
          <AlertTriangle size={14} strokeWidth={1.7} aria-hidden />
          <span>
            Есть строки в USD. Для точного итога завершите расчёт с курсом
            USD/RUB.
          </span>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  muted = false,
  total = false,
  testId,
}: {
  label: React.ReactNode;
  value: string;
  muted?: boolean;
  total?: boolean;
  testId?: string;
}) {
  const className = [
    'order-planned-cost-card__row',
    muted ? 'order-planned-cost-card__row--muted' : '',
    total ? 'order-planned-cost-card__row--total' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className} data-testid={testId}>
      <dt className="order-planned-cost-card__label">{label}</dt>
      <dd className="order-planned-cost-card__value">{value}</dd>
    </div>
  );
}
