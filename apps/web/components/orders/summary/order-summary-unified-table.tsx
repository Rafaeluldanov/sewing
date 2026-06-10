/**
 * `OrderSummaryUnifiedTable` — itemized cost breakdown table.
 *
 * IMPORTANT — what this component actually is:
 *   This component renders a **full itemized cost breakdown** of
 *   an order with one row per material and per operation, including
 *   columns "Раздел / Статья / Кол-во / Ед. / Цена / Сумма за
 *   тираж / За 1 изделие / Доля / Комментарий", a KPI bar
 *   (себестоимость / шт, тираж, цена продажи / шт, выручка, маржа,
 *   маржинальность) and a totals block. Despite the historical
 *   name "Summary" it is **not** a short summary card.
 *
 *   Allowed in dedicated cost summary screens / tabs, such as
 *   the «Сводно по заказу» tab (`costSummary`,
 *   `apps/web/components/orders/tabs/order-summary-tab.tsx`), which
 *   is the canonical mount point on `/admin/orders/[id]`. A future
 *   standalone cost route (e.g. `/admin/orders/:id/cost`) should
 *   reuse this same component.
 *
 *   Do not use this component in the Needs tab
 *   (`apps/web/components/orders/view/tabs/order-needs-tab.tsx`):
 *   it duplicates the per-material rows already rendered by
 *   `OrderMaterialsUnifiedTable` and the per-operation rows
 *   already visible via the operations tab. Forbidden in Needs
 *   tab because it duplicates `OrderMaterialsUnifiedTable`. For
 *   Needs use `OrderMaterialsUnifiedTable` (canonical source of
 *   truth for materials) and an aggregate-only cost card such as
 *   `OrderPlannedCostSummaryCard`. The CostSummary tab and the
 *   Needs tab have explicitly different roles — financial
 *   breakdown vs procurement state — so the same material being
 *   visible in both is by design and is not a duplication.
 *
 *   Renaming this component to `OrderItemizedCostBreakdownTable`
 *   (or similar) is still a recommended follow-up — current name
 *   "Summary" historically invited it back into Needs. See the
 *   regression test `admin-order-needs-no-duplication.smoke.test.ts`
 *   which actively guards against re-introducing this component
 *   into Needs.
 *
 * Где компонент должен жить:
 *   - вкладка «Сводно по заказу» (`OrderSummaryTab`) на
 *     `/admin/orders/[id]?tab=costSummary` — каноническое место;
 *   - dedicated cost deep-dive screen в будущем (например,
 *     отдельный route `/admin/orders/:id/cost`).
 *
 * Зачем существует (история):
 *   - объединить разрозненные блоки «Плановая себестоимость»,
 *     «Себестоимость» и «План операций» в один компактный экран
 *     менеджера. ТЗ §«Главная цель» — одна таблица, отвечающая
 *     на вопрос «сколько стоит одна единица продукции с учётом
 *     всех расходов?».
 *
 * Что это технически:
 *   - server component (`async`); данные берёт из тех же
 *     web-обёрток, что вкладки «Материалы» и «Операции»
 *     (`getOrderWorkshopNeeds` / `getOrderCutReadiness` /
 *     `getOrderPurchaseOrders` / `getOrderPurchaseReceipts` /
 *     `getOperation` / `getOrderProductionBalance`);
 *   - переиспользует pure helpers `buildOrderMaterialRows` и
 *     `buildOrderOperationRows` — не дублирует ни backend, ни
 *     UI-логику двух других вкладок;
 *   - агрегатор `buildOrderSummaryRows` + `computeOrderSummaryTotals`
 *     лежат рядом (`./build-order-summary-rows.ts`) — pure
 *     functions, тестируем без зависимости от Next/React.
 *
 * Что НЕ показываем:
 *   - отдельные большие карточки `OrderCostEstimateCard` /
 *     `OrderPlannedCostSummaryCard` / `OperationPlanBlock` /
 *     legacy materials block — их смысл собран в KPI / unified
 *     table / totals.
 *
 * Backend / Prisma / WorkshopNeed formulas / OperationPlan formulas
 * / OrderCostEstimate logic / payroll / Passport / PurchaseOrder /
 * PurchaseReceipt — НЕ изменялись.
 */
import { AlertTriangle } from 'lucide-react';
import type { CutReadinessDto } from '@sewing/shared/cut-readiness';
import type { MaterialIssueListItemDto } from '@sewing/shared/material-issues';
import type { OperationDetailDto } from '@sewing/shared/operations';
import type { OrderDetailDto } from '@sewing/shared/orders';
import type { OrderProductionBalanceDto } from '@sewing/shared/order-production-balance';
import type { PassportListItemDto } from '@sewing/shared/passports';
import type { PurchaseOrderListItemDto } from '@sewing/shared/purchase-orders';
import type {
  PurchaseReceiptDetailDto,
  PurchaseReceiptListItemDto,
} from '@sewing/shared/purchase-receipts';
import type { WorkshopNeedListItemDto } from '@sewing/shared/workshop-needs';
import {
  AdminEmptyState,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { ApiRequestError, errorText } from '@/lib/api';
import { getOrderCutReadiness } from '@/lib/cut-readiness-api';
import { listOrderMaterialIssues } from '@/lib/material-issues-api';
import { getOperation } from '@/lib/operations-api';
import { getOrderProductionBalance } from '@/lib/order-production-balance-api';
import { getOrderPurchaseOrders } from '@/lib/purchase-orders-api';
import {
  getOrderPurchaseReceipts,
  getPurchaseReceipt,
} from '@/lib/purchase-receipts-api';
import { getOrderWorkshopNeeds } from '@/lib/workshop-needs-api';
import { buildOrderMaterialRows } from '@/components/orders/materials/build-order-material-rows';
import { buildOrderOperationRows } from '@/components/orders/operations/build-order-operation-rows';
import {
  buildOrderSummaryRows,
  computeOrderSummaryTotals,
  type OrderSummaryRow,
  type OrderSummaryTotals,
} from './build-order-summary-rows';

interface Props {
  order: OrderDetailDto;
  passports: PassportListItemDto[];
  /**
   * Скрыть верхнюю KPI-полосу (cost-per-unit / cost-total / sale-price /
   * revenue / margin / margin-pct).
   *
   * Зачем: в управленческой карточке `/admin/orders/[id]` на вкладке
   * «Потребности» эта же сводка повторяется в `TotalsBlock` снизу, и
   * нам важно не показывать одни и те же финансовые цифры дважды.
   * Сама `KpiBar` остаётся в коде на случай других потребителей
   * (например, dashboard-view, где детальная таблица не нужна, а
   * KPI-полоса — нужна).
   *
   * Default — `false`, поведение не меняется для существующих
   * консьюмеров.
   */
  hideKpiBar?: boolean;
}

const RUB_FORMATTER = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 2,
});

function fmtRub(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return RUB_FORMATTER.format(value);
}

function fmtPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1).replace('.', ',')} %`;
}

// ---------------------------------------------------------------------------
// Server-side data loader
// ---------------------------------------------------------------------------

interface LoadedData {
  workshopNeeds: WorkshopNeedListItemDto[];
  cutReadiness: CutReadinessDto | null;
  purchaseOrders: PurchaseOrderListItemDto[];
  purchaseReceipts: PurchaseReceiptListItemDto[];
  purchaseReceiptDetails: Map<string, PurchaseReceiptDetailDto>;
  operationsById: Map<string, OperationDetailDto>;
  productionBalance: OrderProductionBalanceDto | null;
  /**
   * Список документов «Фактический расход материалов» по заказу
   * (`GET /api/orders/:orderId/material-issues`). Используется
   * только для подсчёта order-level фактической стоимости
   * материалов (`materialActualCostRub`) — DRAFT / CANCELLED здесь
   * не отфильтровываются, фильтрацию делает `computeOrderSummaryTotals`.
   *
   * `null`, если запрос упал — в этом случае сводка покажет «—»
   * для факта (не путаем «нет данных» с «факта = 0»).
   */
  materialIssues: MaterialIssueListItemDto[] | null;
  loadErrors: string[];
}

async function loadData(order: OrderDetailDto): Promise<LoadedData> {
  const loadErrors: string[] = [];

  const safe = async <T,>(
    fn: () => Promise<T>,
    fallback: T,
    errorPrefix: string,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      const msg =
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось загрузить данные';
      loadErrors.push(`${errorPrefix}: ${msg}`);
      return fallback;
    }
  };

  const [
    workshopNeeds,
    cutReadiness,
    purchaseOrders,
    purchaseReceipts,
    materialIssues,
  ] = await Promise.all([
    safe(() => getOrderWorkshopNeeds(order.id), [], 'Потребность цеха'),
    safe<CutReadinessDto | null>(
      () => getOrderCutReadiness(order.id),
      null,
      'Готовность к крою',
    ),
    safe(() => getOrderPurchaseOrders(order.id), [], 'Заказы поставщикам'),
    safe(() => getOrderPurchaseReceipts(order.id), [], 'Поступления'),
    // Order-level фактическая стоимость материалов: список
    // документов `MaterialIssue` для текущего заказа. POSTED/DRAFT/
    // CANCELLED фильтрация — на стороне `computeOrderSummaryTotals`.
    // При ошибке fallback — `null`, чтобы UI отличал «факт = 0»
    // от «факт не загружен».
    safe<MaterialIssueListItemDto[] | null>(
      () => listOrderMaterialIssues(order.id),
      null,
      'Фактический расход материалов',
    ),
  ]);

  const purchaseReceiptDetails = new Map<string, PurchaseReceiptDetailDto>();
  await Promise.all(
    purchaseReceipts
      .filter((p) => p.status === 'POSTED')
      .map(async (p) => {
        try {
          const detail = await getPurchaseReceipt(p.id);
          purchaseReceiptDetails.set(p.id, detail);
        } catch {
          // молча — детали приёмки не критичны для сводной таблицы.
        }
      }),
  );

  // Операции: грузим уникальные `OperationDetailDto` для маршрута.
  const operationsById = new Map<string, OperationDetailDto>();
  const uniqueOperationIds = Array.from(
    new Set(order.routeSteps.map((s) => s.operationId)),
  );
  await Promise.all(
    uniqueOperationIds.map(async (id) => {
      try {
        const detail = await getOperation(id);
        operationsById.set(id, detail);
      } catch (e) {
        const msg =
          e instanceof ApiRequestError
            ? errorText(e)
            : 'Не удалось загрузить операцию';
        loadErrors.push(`Операция ${id}: ${msg}`);
      }
    }),
  );

  // Production balance — для warning о узком месте, не критичен.
  let productionBalance: OrderProductionBalanceDto | null = null;
  if (order.routeSteps.length > 0) {
    try {
      productionBalance = await getOrderProductionBalance(order.id);
    } catch (e) {
      const msg =
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось загрузить балансировку';
      loadErrors.push(`Балансировка: ${msg}`);
    }
  }

  return {
    workshopNeeds,
    cutReadiness,
    purchaseOrders,
    purchaseReceipts,
    purchaseReceiptDetails,
    operationsById,
    productionBalance,
    materialIssues,
    loadErrors,
  };
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function SectionCell({ row }: { row: OrderSummaryRow }) {
  return (
    <span
      className="order-summary-table__section"
      data-section={row.section}
    >
      {row.sectionLabel}
    </span>
  );
}

function ArticleCell({ row }: { row: OrderSummaryRow }) {
  return (
    <span className="order-summary-table__article">{row.article}</span>
  );
}

function QtyCell({ row }: { row: OrderSummaryRow }) {
  return (
    <span className="order-summary-table__qty">
      {row.qtyDisplay}
    </span>
  );
}

function UnitCell({ row }: { row: OrderSummaryRow }) {
  return <span className="order-summary-table__unit">{row.unit || '—'}</span>;
}

function PriceCell({ row }: { row: OrderSummaryRow }) {
  return (
    <span
      className={
        row.priceDisplay === '—'
          ? 'order-summary-table__money order-summary-table__money--empty'
          : 'order-summary-table__money'
      }
      data-currency={row.priceCurrency ?? ''}
    >
      {row.priceDisplay}
    </span>
  );
}

function TotalCell({ row }: { row: OrderSummaryRow }) {
  if (row.totalRub == null && row.totalDisplay !== '—') {
    // USD без курса — рисуем оригинальную валюту + warning.
    return (
      <span className="order-summary-table__money">
        {row.totalDisplay}
        <span
          className="order-summary-table__warning"
          title="USD без курса — точный итог в рублях зафиксируется при завершении расчёта."
        >
          <AlertTriangle size={11} strokeWidth={1.7} aria-hidden /> USD
        </span>
      </span>
    );
  }
  return (
    <span
      className={
        row.totalRub == null
          ? 'order-summary-table__money order-summary-table__money--empty'
          : 'order-summary-table__money'
      }
    >
      {row.totalDisplay}
    </span>
  );
}

function UnitCostCell({ row }: { row: OrderSummaryRow }) {
  if (row.unitCostRub == null) {
    return (
      <span className="order-summary-table__unit-cost order-summary-table__unit-cost--empty">
        —
      </span>
    );
  }
  return (
    <span className="order-summary-table__unit-cost">
      {fmtRub(row.unitCostRub)}
    </span>
  );
}

function ShareCell({
  row,
  costTotalRub,
}: {
  row: OrderSummaryRow;
  costTotalRub: number | null;
}) {
  if (
    row.totalRub == null ||
    costTotalRub == null ||
    costTotalRub <= 0
  ) {
    return (
      <span className="order-summary-table__share order-summary-table__share--empty">
        —
      </span>
    );
  }
  const share = (row.totalRub / costTotalRub) * 100;
  return (
    <span className="order-summary-table__share">
      {share.toFixed(1).replace('.', ',')} %
    </span>
  );
}

function CommentCell({ row }: { row: OrderSummaryRow }) {
  if (!row.comment && row.warnings.length === 0) {
    return <span className="admin-muted">—</span>;
  }
  const titleParts: string[] = [];
  if (row.comment) titleParts.push(row.comment);
  if (row.warnings.length > 0) {
    titleParts.push('Предупреждения:');
    for (const w of row.warnings) titleParts.push(`• ${w}`);
  }
  return (
    <div
      className="order-summary-table__comment"
      title={titleParts.join('\n')}
    >
      {row.comment ? (
        <span className="order-summary-table__comment-text">
          {row.comment}
        </span>
      ) : (
        <span className="admin-muted">—</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI bar
// ---------------------------------------------------------------------------

function KpiBar({ totals }: { totals: OrderSummaryTotals }) {
  const items: Array<{
    id: string;
    label: string;
    value: string;
    tone?: 'positive' | 'negative' | 'neutral';
    testId?: string;
  }> = [
    {
      id: 'cost-per-unit',
      label: 'Себестоимость / шт',
      value: fmtRub(totals.costPerUnitRub),
      testId: 'order-summary-kpi-cost-per-unit',
    },
    {
      id: 'cost-total',
      label: 'Себестоимость тиража',
      value: fmtRub(totals.costTotalRub),
      testId: 'order-summary-kpi-cost-total',
    },
    {
      id: 'sale-price',
      label: 'Цена продажи / шт',
      value:
        totals.customerUnitPrice == null
          ? '—'
          : totals.customerCurrency === 'USD'
            ? new Intl.NumberFormat('ru-RU', {
                style: 'currency',
                currency: 'USD',
                maximumFractionDigits: 2,
              }).format(totals.customerUnitPrice)
            : fmtRub(totals.customerUnitPrice),
      testId: 'order-summary-kpi-sale-price',
    },
    {
      id: 'revenue',
      label: 'Выручка',
      value: fmtRub(totals.revenueTotalRub),
      testId: 'order-summary-kpi-revenue',
    },
    {
      id: 'margin',
      label: 'Маржа',
      value: fmtRub(totals.marginTotalRub),
      tone:
        totals.marginTotalRub == null
          ? 'neutral'
          : totals.marginTotalRub >= 0
            ? 'positive'
            : 'negative',
      testId: 'order-summary-kpi-margin',
    },
    {
      id: 'margin-pct',
      label: 'Маржинальность',
      value: fmtPct(totals.marginPercent),
      tone:
        totals.marginPercent == null
          ? 'neutral'
          : totals.marginPercent >= 0
            ? 'positive'
            : 'negative',
      testId: 'order-summary-kpi-margin-pct',
    },
  ];

  return (
    <div
      className="order-summary-kpi-bar"
      data-testid="order-summary-kpi-bar"
    >
      {items.map((it) => (
        <div
          key={it.id}
          className={[
            'order-summary-kpi',
            it.tone === 'positive'
              ? 'order-summary-margin order-summary-margin--positive'
              : '',
            it.tone === 'negative'
              ? 'order-summary-margin order-summary-margin--negative'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid={it.testId}
        >
          <span className="order-summary-kpi__label">{it.label}</span>
          <span className="order-summary-kpi__value">{it.value}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Totals block
// ---------------------------------------------------------------------------

function TotalsBlock({ totals }: { totals: OrderSummaryTotals }) {
  // Тон Δ материалов: перерасход (factual > planned) — danger,
  // экономия — success, ровно по плану — neutral. Если delta
  // неизвестна (нет плана / нет факта) — без тона.
  const materialDeltaTone: 'positive' | 'negative' | 'neutral' | null = (() => {
    if (totals.materialDeltaCostRub == null) return null;
    if (totals.materialDeltaCostRub > 0) return 'negative';
    if (totals.materialDeltaCostRub < 0) return 'positive';
    return 'neutral';
  })();

  const rows: Array<{
    id: string;
    label: string;
    value: string;
    isTotal?: boolean;
    testId?: string;
    /** Inline-тон строки (только для Δ материалов на этой итерации). */
    tone?: 'positive' | 'negative' | 'neutral' | null;
  }> = [
    {
      id: 'material',
      label: 'Материалы за тираж',
      value: fmtRub(totals.byKind.material),
      testId: 'order-summary-totals-material-planned',
    },
    // Фактическая стоимость материалов: Σ MaterialIssue.totalCost
    // по POSTED-документам этого заказа (см.
    // `computeOrderSummaryTotals` / ТЗ §«Order summary actual material
    // cost»). Источник истины — `MaterialIssue.totalCost`, не
    // пересчёт строк на frontend. DRAFT и CANCELLED не учитываются.
    // Документы без `passportId` и строки без `workshopNeedId`
    // тоже учитываются — для order-level summary этого достаточно.
    {
      id: 'material-actual',
      label: 'Материалы за тираж · факт',
      value: fmtRub(totals.materialActualCostRub),
      testId: 'order-summary-totals-material-actual',
    },
    {
      id: 'material-delta',
      label: 'Материалы за тираж · Δ (факт − план)',
      value: fmtRub(totals.materialDeltaCostRub),
      testId: 'order-summary-totals-material-delta',
      tone: materialDeltaTone,
    },
    {
      id: 'hardware',
      label: 'Фурнитура за тираж',
      value: fmtRub(totals.byKind.hardware),
    },
    {
      id: 'application',
      label: 'Нанесение за тираж',
      value: fmtRub(totals.byKind.application),
    },
    {
      id: 'operation',
      label: 'Операции за тираж',
      value: fmtRub(totals.byKind.operation),
    },
  ];
  if (totals.byKind.other != null && totals.byKind.other > 0) {
    rows.push({
      id: 'other',
      label: 'Прочее за тираж',
      value: fmtRub(totals.byKind.other),
    });
  }
  rows.push(
    {
      id: 'cost-total',
      label: 'Итого себестоимость за тираж',
      value: fmtRub(totals.costTotalRub),
      isTotal: true,
      testId: 'order-summary-totals-cost-total',
    },
    {
      id: 'cost-per-unit',
      label: 'Итого себестоимость за 1 изделие',
      value: fmtRub(totals.costPerUnitRub),
      isTotal: true,
      testId: 'order-summary-totals-cost-per-unit',
    },
  );

  // Sale block.
  const saleRows: Array<{
    id: string;
    label: string;
    value: string;
    testId?: string;
  }> = [];
  if (totals.customerUnitPrice != null) {
    saleRows.push({
      id: 'sale-price',
      label: 'Цена продажи за единицу',
      value:
        totals.customerCurrency === 'USD'
          ? new Intl.NumberFormat('ru-RU', {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 2,
            }).format(totals.customerUnitPrice)
          : fmtRub(totals.customerUnitPrice),
    });
    saleRows.push({
      id: 'currency',
      label: 'Валюта продажи',
      value: totals.customerCurrency ?? '—',
    });
    saleRows.push({
      id: 'revenue',
      label: 'Выручка за тираж',
      value: fmtRub(totals.revenueTotalRub),
      testId: 'order-summary-totals-revenue',
    });
  }

  // Margin block — рисуется только если хоть какая-то составляющая
  // считается (revenue / cost). Иначе блок пустой и фейковых нулей
  // не показываем.
  const showMargin =
    totals.marginTotalRub != null ||
    totals.marginPerUnitRub != null ||
    totals.marginPercent != null;
  const marginTone: 'positive' | 'negative' | null =
    totals.marginTotalRub == null
      ? null
      : totals.marginTotalRub >= 0
        ? 'positive'
        : 'negative';

  return (
    <div
      className="order-summary-totals"
      data-testid="order-summary-totals"
    >
      <section className="order-summary-totals__section">
        <h3 className="order-summary-totals__section-title">Себестоимость</h3>
        <dl className="order-summary-totals__rows">
          {rows.map((r) => (
            <div
              key={r.id}
              className={[
                'order-summary-totals__row',
                r.isTotal ? 'order-summary-totals__row--total' : '',
                r.tone === 'positive'
                  ? 'order-summary-margin order-summary-margin--positive'
                  : '',
                r.tone === 'negative'
                  ? 'order-summary-margin order-summary-margin--negative'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-testid={r.testId}
            >
              <dt className="order-summary-totals__label">{r.label}</dt>
              <dd className="order-summary-totals__value">{r.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {saleRows.length > 0 && (
        <section
          className="order-summary-totals__section"
          data-testid="order-summary-totals-sale"
        >
          <h3 className="order-summary-totals__section-title">Продажа</h3>
          <dl className="order-summary-totals__rows">
            {saleRows.map((r) => (
              <div
                key={r.id}
                className="order-summary-totals__row"
                data-testid={r.testId}
              >
                <dt className="order-summary-totals__label">{r.label}</dt>
                <dd className="order-summary-totals__value">{r.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {showMargin && (
        <section
          className={[
            'order-summary-totals__section',
            marginTone === 'positive'
              ? 'order-summary-margin order-summary-margin--positive'
              : '',
            marginTone === 'negative'
              ? 'order-summary-margin order-summary-margin--negative'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid="order-summary-totals-margin"
        >
          <h3 className="order-summary-totals__section-title">Маржа</h3>
          <dl className="order-summary-totals__rows">
            <div
              className="order-summary-totals__row"
              data-testid="order-summary-totals-margin-per-unit"
            >
              <dt className="order-summary-totals__label">Маржа за 1 изделие</dt>
              <dd className="order-summary-totals__value">
                {fmtRub(totals.marginPerUnitRub)}
              </dd>
            </div>
            <div
              className="order-summary-totals__row"
              data-testid="order-summary-totals-margin-total"
            >
              <dt className="order-summary-totals__label">Маржа за тираж</dt>
              <dd className="order-summary-totals__value">
                {fmtRub(totals.marginTotalRub)}
              </dd>
            </div>
            <div
              className="order-summary-totals__row"
              data-testid="order-summary-totals-margin-pct"
            >
              <dt className="order-summary-totals__label">Маржинальность %</dt>
              <dd className="order-summary-totals__value">
                {fmtPct(totals.marginPercent)}
              </dd>
            </div>
          </dl>
        </section>
      )}

      {totals.warnings.length > 0 && (
        <ul
          className="order-summary-table__warning-list"
          role="status"
          data-testid="order-summary-totals-warnings"
        >
          {totals.warnings.map((w) => (
            <li key={w}>
              <AlertTriangle size={12} strokeWidth={1.7} aria-hidden /> {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export async function OrderSummaryUnifiedTable({
  order,
  passports,
  hideKpiBar = false,
}: Props) {
  const data = await loadData(order);

  // Те же row-builders, что во вкладках «Материалы» и «Операции» —
  // не дублируем UI-логику.
  const materialRows = buildOrderMaterialRows({
    workshopNeeds: data.workshopNeeds,
    cutReadiness: data.cutReadiness,
    purchaseOrders: data.purchaseOrders,
    purchaseReceipts: data.purchaseReceipts,
    purchaseReceiptDetails: data.purchaseReceiptDetails,
  });

  const balanceByOperationId = data.productionBalance
    ? new Map(
        data.productionBalance.lines.map(
          (l) => [l.operationId, l] as const,
        ),
      )
    : undefined;

  const operationRows = buildOrderOperationRows({
    routeSteps: order.routeSteps,
    items: order.items,
    qtyPlanTotal: order.qtyPlanTotal,
    passports,
    operationsById: data.operationsById,
    balanceByOperationId,
  });

  const summaryRows = buildOrderSummaryRows({
    materialRows,
    operationRows,
    currentCostEstimate: order.currentCostEstimate ?? null,
    qtyTotal: order.qtyPlanTotal,
    // Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
    // `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`).
    materialsAndHardwareCostPolicy:
      order.materialsAndHardwareCostPolicy ?? 'INCLUDE',
  });

  const totals = computeOrderSummaryTotals({
    rows: summaryRows,
    qtyTotal: order.qtyPlanTotal,
    customerUnitPrice: order.customerUnitPrice ?? null,
    customerCurrency: order.customerCurrency ?? null,
    operationPlanIsStale: order.operationPlanIsStale === true,
    hasCompletedEstimate: order.currentCostEstimate != null,
    // `null` (запрос упал) пробрасываем как `undefined`, чтобы
    // `computeOrderSummaryTotals` оставил `materialActualCostRub =
    // null` и UI показал «—» вместо `0 ₽`. Пустой массив — это
    // явный сигнал «факта по заказу нет», тогда показываем `0 ₽`.
    materialIssues: data.materialIssues ?? undefined,
    materialsAndHardwareCostPolicy:
      order.materialsAndHardwareCostPolicy ?? 'INCLUDE',
  });

  // Колонки: Раздел / Статья / Кол-во / Ед. / Цена / Сумма за тираж /
  // За 1 изделие / Доля / Комментарий (9 колонок).
  const columns: AdminTableColumn<OrderSummaryRow>[] = [
    {
      key: 'section',
      header: 'Раздел',
      render: (row) => <SectionCell row={row} />,
    },
    {
      key: 'article',
      header: 'Статья',
      render: (row) => <ArticleCell row={row} />,
    },
    {
      key: 'qty',
      header: 'Кол-во',
      align: 'right',
      render: (row) => <QtyCell row={row} />,
    },
    {
      key: 'unit',
      header: 'Ед.',
      render: (row) => <UnitCell row={row} />,
    },
    {
      key: 'price',
      header: 'Цена',
      align: 'right',
      render: (row) => <PriceCell row={row} />,
    },
    {
      key: 'total',
      header: 'Сумма за тираж',
      align: 'right',
      render: (row) => <TotalCell row={row} />,
    },
    {
      key: 'unitCost',
      header: 'За 1 изделие',
      align: 'right',
      render: (row) => <UnitCostCell row={row} />,
    },
    {
      key: 'share',
      header: 'Доля',
      align: 'right',
      render: (row) => (
        <ShareCell row={row} costTotalRub={totals.costTotalRub} />
      ),
    },
    {
      key: 'comment',
      header: 'Комментарий',
      render: (row) => <CommentCell row={row} />,
    },
  ];

  return (
    <div
      className="order-summary-table-card"
      data-testid="order-summary-unified-table"
    >
      {!hideKpiBar && <KpiBar totals={totals} />}

      {data.loadErrors.length > 0 && (
        <ul
          className="order-summary-table-card__errors"
          role="alert"
          data-testid="order-summary-load-errors"
        >
          {data.loadErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {summaryRows.length === 0 ? (
        <AdminEmptyState
          title="Сводки пока нет"
          hint="Сводная себестоимость появится после расчёта материалов и операций."
        />
      ) : (
        <div className="order-summary-table-wrap">
          <AdminTable
            className="order-summary-table"
            rows={summaryRows}
            columns={columns}
            rowKey={(r) => `${r.sourceKind}-${r.id}`}
          />
        </div>
      )}

      <TotalsBlock totals={totals} />
    </div>
  );
}
