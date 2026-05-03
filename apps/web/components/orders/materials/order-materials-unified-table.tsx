/**
 * `OrderMaterialsUnifiedTable` — единая таблица материалов в карточке
 * заказа `/admin/orders/[id]` (вкладка «Материалы»).
 *
 * Зачем:
 *   - объединить три раздельных блока «Потребность цеха» /
 *     «Себестоимость» / «Готовность к крою» в один компактный
 *     рабочий экран закупщика и менеджера. ТЗ §«Главная цель» —
 *     одна таблица, в которой видно «что нужно купить, сколько,
 *     по какой цене, от какого поставщика, что уже принято и
 *     лежит в ячейках, готов ли материал к крою».
 *
 * Что это технически:
 *   - server component (`async`); данные берёт из уже существующих
 *     web-обёрток (`getOrderWorkshopNeeds` /
 *     `getOrderCutReadiness` / `getOrderPurchaseOrders` /
 *     `getOrderPurchaseReceipts` / `getPurchaseReceipt`);
 *   - Backend / Prisma / WorkshopNeed formulas / OrderCostEstimate
 *     logic / CutReadinessService / OrderMaterialArrivalOverride —
 *     НЕ изменялись;
 *   - агрегация делается в pure-helper'е
 *     `buildOrderMaterialRows` (см. рядом). Это даёт нам
 *     unit-тестируемую функцию без зависимости от Next/React.
 *
 * Что НЕ показываем:
 *   - номенклатуру заказа (она в hero / вкладке «Продукция»);
 *   - номер заказа, клиента (тоже в hero);
 *   - отдельные большие карточки «Потребность цеха» /
 *     «Себестоимость» / «Готовность к крою» — они объединены здесь
 *     или живут в других вкладках («Сводно», «Логистика»).
 *
 * Inline-edit MVP-минимум: таблица показывает значения как есть,
 * редактирование `purchaseQty` / `quotedPrice` / поставщика идёт
 * через ссылку «Открыть в потребности цеха». Полноценный inline-
 * edit можно добавить позже, не меняя backend.
 */
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowUpRight,
  Image as ImageIcon,
  Palette,
} from 'lucide-react';
import type { CutReadinessDto } from '@sewing/shared/cut-readiness';
import type { MaterialIssueDetailDto } from '@sewing/shared/material-issues';
import type {
  PurchaseReceiptDetailDto,
  PurchaseReceiptListItemDto,
} from '@sewing/shared/purchase-receipts';
import type { PurchaseOrderListItemDto } from '@sewing/shared/purchase-orders';
import type { WorkshopNeedListItemDto } from '@sewing/shared/workshop-needs';
import {
  AdminEmptyState,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { ApiRequestError } from '@/lib/api';
import { formatDateRu } from '@/lib/date-format';
import { getOrderCutReadiness } from '@/lib/cut-readiness-api';
import { getOrderPurchaseOrders } from '@/lib/purchase-orders-api';
import {
  getOrderPurchaseReceipts,
  getPurchaseReceipt,
} from '@/lib/purchase-receipts-api';
import { getOrderWorkshopNeeds } from '@/lib/workshop-needs-api';
import {
  buildOrderMaterialRows,
  summariseOrderMaterialRows,
  type OrderMaterialStatusTone,
  type OrderMaterialTableRow,
} from './build-order-material-rows';

interface Props {
  orderId: string;
  /**
   * Документы фактического расхода материалов по заказу
   * (`MaterialIssue` + `MaterialIssueLine`). Опционально:
   * `OrderNeedsTab` пробрасывает преподгруженный массив, тот же,
   * что и в `MaterialIssuesSection` — без второго fetch (см.
   * frontend-итерация «план/факт»).
   *
   * Из них в строки таблицы ложится только агрегат POSTED по
   * `workshopNeedId`. DRAFT и CANCELLED игнорируются. Если
   * `undefined` или пусто — таблица показывает план/факт-колонки
   * с «нет проведённых расходов».
   */
  materialIssues?: MaterialIssueDetailDto[];
}

const RUB_FORMATTER = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 2,
});

const USD_FORMATTER = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

function formatRub(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return RUB_FORMATTER.format(n);
}

function formatUsd(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return USD_FORMATTER.format(n);
}

function tone(adminTone: OrderMaterialStatusTone): AdminStatusTone {
  switch (adminTone) {
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'danger':
      return 'danger';
    case 'info':
      return 'info';
    case 'neutral':
    default:
      return 'muted';
  }
}

function PriceCell({ row }: { row: OrderMaterialTableRow }) {
  if (!row.quotedPrice || Number(row.quotedPrice) <= 0) {
    return (
      <span className="order-materials-table__money order-materials-table__money--empty">
        —
      </span>
    );
  }
  const isUsd = String(row.quotedCurrency ?? 'RUB').toUpperCase() === 'USD';
  const formatted = isUsd
    ? formatUsd(row.quotedPrice)
    : formatRub(row.quotedPrice);
  return (
    <span className="order-materials-table__money">
      {formatted}
      {row.unit ? ` / ${row.unit}` : ''}
    </span>
  );
}

function TotalCell({ row }: { row: OrderMaterialTableRow }) {
  if (row.lineTotalRub) {
    return (
      <span className="order-materials-table__money">
        {formatRub(row.lineTotalRub)}
      </span>
    );
  }
  if (row.lineTotalUsd) {
    return (
      <span className="order-materials-table__money">
        {formatUsd(row.lineTotalUsd)}
        <span
          className="order-materials-table__warning"
          title="USD без курса — точный итог в рублях будет известен после фиксации расчёта."
        >
          <AlertTriangle size={12} strokeWidth={1.7} aria-hidden />
          USD
        </span>
      </span>
    );
  }
  return (
    <span className="order-materials-table__money order-materials-table__money--empty">
      —
    </span>
  );
}

function PurchaseQtyCell({ row }: { row: OrderMaterialTableRow }) {
  if (row.purchaseQty != null) {
    return (
      <span className="order-materials-table__qty">
        {row.purchaseQty}
        {row.unit ? ` ${row.unit}` : ''}
      </span>
    );
  }
  return (
    <span className="order-materials-table__qty order-materials-table__qty--placeholder">
      —
      <span className="order-materials-table__qty-hint">
        расчёт: {row.calculatedQty} {row.unit}
      </span>
    </span>
  );
}

function DescriptionCell({
  row,
  orderId,
}: {
  row: OrderMaterialTableRow;
  orderId: string;
}) {
  // CTA «Указать цвет» (см. ТЗ §C «Needs UI»): рядом с warning
  // даём ссылку на новую вкладку «План» к блоку выбора цвета.
  // Anchor `#order-material-colors` — единственный стабильный
  // ключ, доступный из row на этом шаге: row.id — это
  // `WorkshopNeed.id`, а не `OrderMaterialRequirement.id`, и
  // расширять backend под per-row deep-link мы намеренно не
  // хотим (см. ТЗ §F «Не менять»).
  const colorCtaHref = `/admin/orders/${orderId}?tab=plan#order-material-colors`;
  return (
    <div className="order-materials-table__description">
      {row.imageUrl && (
        <div
          className="order-materials-table__image"
          aria-hidden
          title={row.description}
        >
          {/* Используем нативный <img>: server-component, без next/image
              optimization. Картинка может приходить с любого CDN, а сервер
              у нас уже отдаёт preview через `materialImageUrl`. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={row.imageUrl} alt="" loading="lazy" />
        </div>
      )}
      {!row.imageUrl && (
        <div
          className="order-materials-table__image order-materials-table__image--empty"
          aria-hidden
        >
          <ImageIcon size={16} strokeWidth={1.6} />
        </div>
      )}
      <div className="order-materials-table__description-body">
        <div className="order-materials-table__description-main">
          {row.description}
        </div>
        {row.metaText && (
          <div className="order-materials-table__description-meta">
            {row.metaText}
          </div>
        )}
        {row.requiresColorSelection && !row.colorText && (
          <div className="order-materials-table__warning">
            <AlertTriangle size={12} strokeWidth={1.7} aria-hidden />
            Цвет нужно указать в заказе
            <Link
              href={colorCtaHref}
              prefetch={false}
              className="order-materials-table__warning-cta"
              data-testid="order-materials-color-cta"
            >
              <Palette size={12} strokeWidth={1.7} aria-hidden />
              Указать цвет
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusCell({ row }: { row: OrderMaterialTableRow }) {
  return (
    <div className="order-materials-table__status">
      <AdminStatusBadge tone={tone(row.statusTone)}>
        {row.statusLabel}
      </AdminStatusBadge>
      {row.secondaryBadge && (
        <AdminStatusBadge tone={tone(row.secondaryBadge.tone)}>
          {row.secondaryBadge.label}
        </AdminStatusBadge>
      )}
    </div>
  );
}

function CommentCell({ row }: { row: OrderMaterialTableRow }) {
  const titleParts: string[] = [];
  if (row.commentText) titleParts.push(row.commentText);
  if (row.warnings.length > 0) {
    titleParts.push('Предупреждения:');
    for (const w of row.warnings) titleParts.push(`• ${w}`);
  }
  const title = titleParts.length > 0 ? titleParts.join('\n') : undefined;

  if (!row.commentText && row.warnings.length === 0) {
    return (
      <span className="order-materials-table__comment order-materials-table__comment--empty">
        —
      </span>
    );
  }

  return (
    <div className="order-materials-table__comment" title={title}>
      {row.commentText && (
        <div className="order-materials-table__comment-text">
          {row.commentText}
        </div>
      )}
      {row.warnings.length > 0 && (
        <ul className="order-materials-table__comment-warnings">
          {row.warnings.slice(0, 2).map((w) => (
            <li key={w}>
              <AlertTriangle size={11} strokeWidth={1.7} aria-hidden /> {w}
            </li>
          ))}
          {row.warnings.length > 2 && (
            <li className="admin-muted">+ ещё {row.warnings.length - 2}</li>
          )}
        </ul>
      )}
    </div>
  );
}

function SupplierCell({ row }: { row: OrderMaterialTableRow }) {
  if (!row.supplierName && !row.supplierItemText) {
    return (
      <span className="admin-muted" data-testid="order-materials-supplier-empty">
        —
      </span>
    );
  }
  return (
    <div className="order-materials-table__supplier">
      <div className="order-materials-table__supplier-name">
        {row.supplierName ?? '—'}
      </div>
      {row.supplierItemText && (
        <div
          className="order-materials-table__supplier-item admin-muted"
          title={row.supplierItemText}
        >
          {row.supplierItemText}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// План / факт по фактическому расходу материалов
// (frontend-итерация «план/факт» поверх MaterialIssue)
// ---------------------------------------------------------------------------

function formatQty(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  // Decimal-as-string: убираем хвостовые нули, локаль `ru-RU`.
  return n.toLocaleString('ru-RU', {
    maximumFractionDigits: 4,
    minimumFractionDigits: 0,
  });
}

function formatSignedQty(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const formatted = formatQty(Math.abs(n));
  return n > 0 ? `+${formatted}` : `−${formatted}`;
}

function formatSignedRub(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return formatRub(0);
  const formatted = formatRub(Math.abs(n));
  return n > 0 ? `+${formatted}` : `−${formatted}`;
}

function deltaQtyTone(
  delta: number,
): 'over' | 'under' | 'equal' {
  if (delta > 0) return 'over';
  if (delta < 0) return 'under';
  return 'equal';
}

function PlanFactQtyCell({ row }: { row: OrderMaterialTableRow }) {
  const issuedNum = Number(row.issuedQtyFact);
  const hasFact = row.postedIssueLineCount > 0;
  const deltaNum = Number(row.deltaQty);
  const tone = Number.isFinite(deltaNum) ? deltaQtyTone(deltaNum) : 'equal';
  return (
    <div
      className="order-materials-table__planfact"
      data-testid="order-materials-planfact-qty"
    >
      <div className="order-materials-table__planfact-row">
        <span className="order-materials-table__planfact-label">План</span>
        <span className="order-materials-table__planfact-value">
          {formatQty(row.plannedQty)}
          {row.unit ? ` ${row.unit}` : ''}
        </span>
      </div>
      <div className="order-materials-table__planfact-row">
        <span className="order-materials-table__planfact-label">Факт</span>
        <span className="order-materials-table__planfact-value">
          {row.unitMismatch ? (
            // Разные единицы измерения — не суммируем количество
            // (см. ТЗ §3 «фактический расход / unit mismatch»).
            <span
              className="order-materials-table__warning"
              title="POSTED строки с этой потребностью используют другую единицу измерения. Конвертация в MVP не делается — стоимость суммируется, количество — нет."
              data-testid="order-materials-planfact-unit-mismatch"
            >
              <AlertTriangle size={11} strokeWidth={1.7} aria-hidden />
              Ед. изм. отличаются
            </span>
          ) : !hasFact ? (
            <span className="order-materials-table__qty--placeholder">
              0{row.unit ? ` ${row.unit}` : ''}
              <span className="order-materials-table__qty-hint">
                нет проведённых расходов
              </span>
            </span>
          ) : (
            <>
              {formatQty(issuedNum)}
              {row.unit ? ` ${row.unit}` : ''}
            </>
          )}
        </span>
      </div>
      {hasFact && !row.unitMismatch && (
        <div
          className={`order-materials-table__planfact-row order-materials-table__planfact-delta order-materials-table__planfact-delta--${tone}`}
        >
          <span className="order-materials-table__planfact-label">Δ</span>
          <span className="order-materials-table__planfact-value">
            {formatSignedQty(deltaNum)}
            {row.unit ? ` ${row.unit}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

function PlanFactCostCell({ row }: { row: OrderMaterialTableRow }) {
  const hasFact = row.postedIssueLineCount > 0;
  const actualNum = Number(row.actualCost);
  const deltaNum = row.deltaCost == null ? null : Number(row.deltaCost);
  const tone =
    deltaNum != null && Number.isFinite(deltaNum)
      ? deltaQtyTone(deltaNum)
      : 'equal';
  return (
    <div
      className="order-materials-table__planfact"
      data-testid="order-materials-planfact-cost"
    >
      <div className="order-materials-table__planfact-row">
        <span className="order-materials-table__planfact-label">План</span>
        <span className="order-materials-table__planfact-value">
          {row.plannedCost == null ? (
            // Нет цены или USD без курса — `null` плановой стоимости
            // (см. build-order-material-rows.ts).
            <span className="order-materials-table__money--empty">—</span>
          ) : (
            formatRub(row.plannedCost)
          )}
        </span>
      </div>
      <div className="order-materials-table__planfact-row">
        <span className="order-materials-table__planfact-label">Факт</span>
        <span className="order-materials-table__planfact-value">
          {!hasFact ? (
            <span className="order-materials-table__money--empty">
              {formatRub(0)}
              <span className="order-materials-table__qty-hint">
                нет проведённых расходов
              </span>
            </span>
          ) : (
            formatRub(actualNum)
          )}
        </span>
      </div>
      {hasFact && deltaNum != null && Number.isFinite(deltaNum) && (
        <div
          className={`order-materials-table__planfact-row order-materials-table__planfact-delta order-materials-table__planfact-delta--${tone}`}
        >
          <span className="order-materials-table__planfact-label">Δ</span>
          <span className="order-materials-table__planfact-value">
            {formatSignedRub(deltaNum)}
          </span>
        </div>
      )}
    </div>
  );
}

function DateCell({ row }: { row: OrderMaterialTableRow }) {
  if (!row.expectedOrReceivedDate) {
    return <span className="admin-muted">—</span>;
  }
  const formatted = formatDateRu(row.expectedOrReceivedDate);
  if (row.dateSource === 'received') {
    return (
      <span
        className="order-materials-table__date order-materials-table__date--received"
        title="Дата фактической приёмки (по последней POSTED-приёмке этого материала)"
      >
        {formatted}
      </span>
    );
  }
  return (
    <span
      className="order-materials-table__date order-materials-table__date--expected"
      title="Ожидаемая дата поставки (из потребности или активного заказа поставщику)"
    >
      {formatted}
    </span>
  );
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
  loadErrors: string[];
}

async function loadData(orderId: string): Promise<LoadedData> {
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
          ? `${e.message}${e.code ? ` (${e.code})` : ''}`
          : 'Не удалось загрузить данные';
      loadErrors.push(`${errorPrefix}: ${msg}`);
      return fallback;
    }
  };

  const [needs, cutReadiness, purchaseOrders, purchaseReceipts] = await Promise.all([
    safe(() => getOrderWorkshopNeeds(orderId), [], 'Потребность цеха'),
    safe<CutReadinessDto | null>(
      () => getOrderCutReadiness(orderId),
      null,
      'Готовность к крою',
    ),
    safe(() => getOrderPurchaseOrders(orderId), [], 'Заказы поставщикам'),
    safe(() => getOrderPurchaseReceipts(orderId), [], 'Поступления'),
  ]);

  const purchaseReceiptDetails = new Map<string, PurchaseReceiptDetailDto>();
  // Подгружаем детали только для POSTED-приёмок, чтобы найти
  // фактическую дату приёмки по `workshopNeedId`. Параллельно,
  // как PurchaseReceiptsCard делает; ошибки одной приёмки не
  // ломают весь блок.
  await Promise.all(
    purchaseReceipts
      .filter((p) => p.status === 'POSTED')
      .map(async (p) => {
        try {
          const detail = await getPurchaseReceipt(p.id);
          purchaseReceiptDetails.set(p.id, detail);
        } catch {
          // Молча игнорируем — дата деградирует к ожидаемой.
        }
      }),
  );

  return {
    workshopNeeds: needs,
    cutReadiness,
    purchaseOrders,
    purchaseReceipts,
    purchaseReceiptDetails,
    loadErrors,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export async function OrderMaterialsUnifiedTable({
  orderId,
  materialIssues,
}: Props) {
  const data = await loadData(orderId);
  const rows = buildOrderMaterialRows({
    workshopNeeds: data.workshopNeeds,
    cutReadiness: data.cutReadiness,
    purchaseOrders: data.purchaseOrders,
    purchaseReceipts: data.purchaseReceipts,
    purchaseReceiptDetails: data.purchaseReceiptDetails,
    materialIssues,
  });
  const summary = summariseOrderMaterialRows(rows);

  const columns: AdminTableColumn<OrderMaterialTableRow>[] = [
    {
      key: 'role',
      header: 'Роль',
      render: (row) => (
        <span
          className="order-materials-table__role"
          data-material-role={row.materialRoleRaw ?? ''}
        >
          {row.roleLabel}
        </span>
      ),
    },
    {
      key: 'description',
      header: 'Описание',
      render: (row) => <DescriptionCell row={row} orderId={orderId} />,
    },
    {
      key: 'calculatedQty',
      header: 'Чистая',
      align: 'right',
      render: (row) => (
        <span className="order-materials-table__qty">
          {row.calculatedQty}
          {row.unit ? ` ${row.unit}` : ''}
        </span>
      ),
    },
    {
      key: 'purchaseQty',
      header: 'К закупке',
      align: 'right',
      render: (row) => <PurchaseQtyCell row={row} />,
    },
    {
      key: 'price',
      header: 'Цена',
      align: 'right',
      render: (row) => <PriceCell row={row} />,
    },
    {
      key: 'total',
      header: 'Сумма',
      align: 'right',
      render: (row) => <TotalCell row={row} />,
    },
    {
      // План / факт по фактическому расходу материалов
      // (frontend-итерация «план/факт» поверх MaterialIssue).
      // Компактный блок «План / Факт / Δ» по количеству — сидит
      // рядом с «К закупке», чтобы менеджер сразу видел разницу
      // между производственной потребностью и фактически выданным
      // в крой количеством. Отдельная вкладка / страница НЕ
      // создаётся — это решение владельца UI-итерации.
      key: 'planFactQty',
      header: 'План / факт',
      align: 'right',
      render: (row) => <PlanFactQtyCell row={row} />,
    },
    {
      key: 'planFactCost',
      header: 'Стоимость план / факт',
      align: 'right',
      render: (row) => <PlanFactCostCell row={row} />,
    },
    {
      key: 'received',
      header: 'Принято',
      align: 'right',
      render: (row) => (
        <span className="order-materials-table__qty">
          {row.receivedQty}
          {row.unit ? ` ${row.unit}` : ''}
        </span>
      ),
    },
    {
      key: 'placed',
      header: 'В ячейках',
      align: 'right',
      render: (row) => (
        <span className="order-materials-table__qty">
          {row.placedQty}
          {row.unit ? ` ${row.unit}` : ''}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (row) => <StatusCell row={row} />,
    },
    {
      key: 'date',
      header: 'Дата поступления',
      render: (row) => <DateCell row={row} />,
    },
    {
      key: 'supplier',
      header: 'Поставщик',
      render: (row) => <SupplierCell row={row} />,
    },
    {
      key: 'comment',
      header: 'Комментарий',
      render: (row) => <CommentCell row={row} />,
    },
  ];

  return (
    <div
      className="order-materials-table-card"
      data-testid="order-materials-unified-table"
    >
      <div className="order-materials-table-card__head">
        <div className="order-materials-table-card__title">Материалы</div>
        <div className="order-materials-table-card__summary admin-muted">
          {rows.length === 0 ? (
            'Строк ещё нет'
          ) : (
            <>
              <span data-testid="order-materials-summary-rows">
                {rows.length} {pluralRu(rows.length, ['строка', 'строки', 'строк'])}
              </span>
              {summary.totalRub != null && (
                <>
                  {' · '}
                  <span data-testid="order-materials-summary-total">
                    сумма {formatRub(summary.totalRub)}
                  </span>
                </>
              )}
              {summary.hasUsdLines && (
                <>
                  {' · '}
                  <span title="Есть строки в USD: точная сумма в рублях будет известна после фиксации расчёта.">
                    есть USD
                  </span>
                </>
              )}
              {summary.blockerCount > 0 && (
                <>
                  {' · '}
                  <span
                    className="order-materials-table-card__summary-blockers"
                    data-testid="order-materials-summary-blockers"
                  >
                    предупреждений {summary.blockerCount}
                  </span>
                </>
              )}
            </>
          )}
        </div>
        <Link
          href={`/admin/workshop-needs?orderId=${encodeURIComponent(orderId)}`}
          className="admin-table__action-link order-materials-table-card__edit-link"
        >
          Открыть в потребности цеха
          <ArrowUpRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      </div>

      {data.loadErrors.length > 0 && (
        <ul
          className="order-materials-table-card__errors"
          role="alert"
          data-testid="order-materials-load-errors"
        >
          {data.loadErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {rows.length === 0 ? (
        <AdminEmptyState
          title="Материалов пока нет"
          hint="Расчёт потребности появится после перевода заказа в статус «Расчёт» — система соберёт строки по лекалу и техкарте."
        />
      ) : (
        <div className="order-materials-table-wrap">
          <AdminTable
            className="order-materials-table"
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
          />
        </div>
      )}
    </div>
  );
}

function pluralRu(
  count: number,
  forms: [string, string, string],
): string {
  const n = Math.abs(count) % 100;
  const n10 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n10 > 1 && n10 < 5) return forms[1];
  if (n10 === 1) return forms[0];
  return forms[2];
}
