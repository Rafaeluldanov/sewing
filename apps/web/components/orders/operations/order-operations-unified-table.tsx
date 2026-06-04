/**
 * `OrderOperationsUnifiedTable` — единая таблица операций в карточке
 * заказа `/admin/orders/[id]` (вкладка «Операции»).
 *
 * Зачем (см. ТЗ §«Главная цель»):
 *   - объединить разрозненные блоки «Маршрут», «План операций» и
 *     «Производственная цепочка» в один компактный рабочий экран
 *     менеджера;
 *   - таблица показывает только саму операцию (без колонки «Категория»);
 *   - снизу — компактный итог (стоимость / время / узкое место);
 *   - никаких отдельных карточек.
 *
 * Что НЕ делаем:
 *   - не меняем Prisma / backend / payroll / Passport / OperationEntry /
 *     ProductionBalanceService / OperationPlanService;
 *   - не вводим новых статусов в БД — статусы Ожидает/В работе/
 *     Выполнено вычисляются из уже существующих passports
 *     (`Passport.currentRouteStepIndex`, `Passport.status`); см.
 *     `build-order-operation-rows.ts`;
 *   - не дублируем backend formulas — для FIXED/BY_SIZE считаем
 *     стоимость и время напрямую (rate × qty / Σ rate×qty), для
 *     SALARY_ONLY используем сводный snapshot `Order.operationCostPlanRub`,
 *     если backend его уже посчитал, иначе показываем «окладная».
 */
import { AlertTriangle } from 'lucide-react';
import type { OperationDetailDto } from '@sewing/shared/operations';
import type {
  OrderDetailDto,
  OrderLogisticsLineDto,
  OrderLogisticsStatus,
  OrderRouteStepDto,
} from '@sewing/shared/orders';
import type { OrderProductionBalanceDto } from '@sewing/shared/order-production-balance';
import type { PassportListItemDto } from '@sewing/shared/passports';
import {
  AdminEmptyState,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { ApiRequestError } from '@/lib/api';
import { getOperation } from '@/lib/operations-api';
import { getOrderProductionBalance } from '@/lib/order-production-balance-api';
import { formatDurationSec } from '@/lib/operations-time-norm';
import {
  buildOrderOperationRows,
  summariseOrderOperationRows,
  type OrderOperationStatusTone,
  type OrderOperationTableRow,
} from './build-order-operation-rows';
import {
  OrderLogisticsAddButton,
  OrderLogisticsRowActions,
} from './order-logistics-controls';

interface Props {
  order: OrderDetailDto;
  passports: PassportListItemDto[];
}

/**
 * Строки таблицы операций — объединение вычисляемых операций
 * (`kind: 'operation'`) и ручных строк логистики (`kind: 'logistics'`),
 * которые менеджер добавляет в конце таблицы. Логистика рендерится
 * последними строками той же таблицы.
 */
type OperationRow = OrderOperationTableRow & { kind: 'operation' };
interface LogisticsRow {
  kind: 'logistics';
  id: string;
  rowNumber: string;
  line: OrderLogisticsLineDto;
}
type UnifiedRow = OperationRow | LogisticsRow;

const LOGISTICS_DATE_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  // timeZone обязателен — иначе RSC считает по UTC, hydration «съезжает»
  // и тихо ломает onClick в той же секции (см. feedback_hydration_timezone).
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function formatLogisticsDeadline(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return LOGISTICS_DATE_FORMATTER.format(d);
}

function logisticsStatusTone(status: OrderLogisticsStatus): AdminStatusTone {
  switch (status) {
    case 'DELIVERED':
      return 'success';
    case 'IN_TRANSIT':
      return 'info';
    case 'ORDERED':
      return 'warning';
    case 'CANCELLED':
    default:
      return 'muted';
  }
}

const RUB_FORMATTER = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 2,
});

function formatRub(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return RUB_FORMATTER.format(value);
}

function tone(adminTone: OrderOperationStatusTone): AdminStatusTone {
  switch (adminTone) {
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    case 'neutral':
    default:
      return 'muted';
  }
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function NumberCell({ row }: { row: OrderOperationTableRow }) {
  return (
    <span className="order-operations-table__qty">
      <strong>{row.rowNumber}</strong>
    </span>
  );
}

function OperationCell({ row }: { row: OrderOperationTableRow }) {
  // ТЗ §1: показываем только название операции, без колонки/префикса
  // «Категория». Код операции остаётся в data-attribute для дебага и
  // smoke-тестов.
  return (
    <span
      className="order-operations-table__op-name"
      data-operation-code={row.operationCode}
    >
      {row.operationName}
    </span>
  );
}

function StatusCell({ row }: { row: OrderOperationTableRow }) {
  return (
    <div className="order-operations-table__status">
      <AdminStatusBadge tone={tone(row.statusTone)}>
        {row.statusLabel}
      </AdminStatusBadge>
    </div>
  );
}

function QtyCell({ value }: { value: number }) {
  return (
    <span className="order-operations-table__qty">
      {value > 0 ? value.toLocaleString('ru-RU') : '—'}
    </span>
  );
}

function NormCell({ row }: { row: OrderOperationTableRow }) {
  if (row.normLabel === '—') {
    return (
      <span className="order-operations-table__duration order-operations-table__duration--empty">
        —
      </span>
    );
  }
  return (
    <span
      className="order-operations-table__duration"
      data-time-norm-mode={row.timeNormMode ?? ''}
    >
      {row.normLabel}
    </span>
  );
}

function PriceCell({ row }: { row: OrderOperationTableRow }) {
  if (row.priceLabel === '—') {
    return (
      <span className="order-operations-table__money order-operations-table__money--empty">
        —
      </span>
    );
  }
  return (
    <span
      className="order-operations-table__money"
      data-pricing-mode={row.pricingMode ?? ''}
    >
      {row.priceLabel}
    </span>
  );
}

function TimeCell({ row }: { row: OrderOperationTableRow }) {
  if (row.totalTimeSec == null) {
    return (
      <span className="order-operations-table__duration order-operations-table__duration--empty">
        —
      </span>
    );
  }
  return (
    <span className="order-operations-table__duration">
      {formatDurationSec(row.totalTimeSec)}
    </span>
  );
}

function CostCell({ row }: { row: OrderOperationTableRow }) {
  if (row.lineTotalRub != null) {
    return (
      <span className="order-operations-table__money">
        {formatRub(row.lineTotalRub)}
      </span>
    );
  }
  if (row.costFallbackLabel) {
    return (
      <span
        className="order-operations-table__money order-operations-table__money--empty"
        title="Окладная операция: точная стоимость берётся из снимка плана операций (backend)."
      >
        {row.costFallbackLabel}
      </span>
    );
  }
  return (
    <span className="order-operations-table__money order-operations-table__money--empty">
      —
    </span>
  );
}

function CommentCell({ row }: { row: OrderOperationTableRow }) {
  if (!row.commentText && row.warnings.length === 0) {
    return (
      <span className="order-operations-table__comment order-operations-table__comment--empty">
        —
      </span>
    );
  }
  const titleParts: string[] = [];
  if (row.commentText) titleParts.push(row.commentText);
  if (row.warnings.length > 0) {
    titleParts.push('Предупреждения:');
    for (const w of row.warnings) titleParts.push(`• ${w}`);
  }
  return (
    <div className="order-operations-table__comment" title={titleParts.join('\n')}>
      {row.commentText && (
        <div className="order-operations-table__comment-text">
          {row.commentText}
        </div>
      )}
      {row.warnings.length > 0 && (
        <ul className="order-operations-table__comment-warnings">
          {row.warnings.slice(0, 2).map((w) => (
            <li key={w}>
              <span className="order-operations-table__warning">
                <AlertTriangle size={11} strokeWidth={1.7} aria-hidden /> {w}
              </span>
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

// ---------------------------------------------------------------------------
// Server-side data loader
// ---------------------------------------------------------------------------

interface LoadedData {
  operationsById: Map<string, OperationDetailDto>;
  productionBalance: OrderProductionBalanceDto | null;
  loadErrors: string[];
}

async function loadData(
  orderId: string,
  routeSteps: OrderRouteStepDto[],
): Promise<LoadedData> {
  const loadErrors: string[] = [];
  const operationsById = new Map<string, OperationDetailDto>();

  // Уникальные operationId — на случай повторов в snapshot маршрута
  // (теоретически Zod-схема такое запрещает, но snapshot независим).
  const uniqueOperationIds = Array.from(
    new Set(routeSteps.map((s) => s.operationId)),
  );

  const opsPromise = Promise.all(
    uniqueOperationIds.map(async (id) => {
      try {
        const detail = await getOperation(id);
        operationsById.set(id, detail);
      } catch (e) {
        const msg =
          e instanceof ApiRequestError
            ? `${e.message}${e.code ? ` (${e.code})` : ''}`
            : 'Не удалось загрузить операцию';
        loadErrors.push(`Операция ${id}: ${msg}`);
      }
    }),
  );

  const balancePromise: Promise<OrderProductionBalanceDto | null> =
    routeSteps.length > 0
      ? getOrderProductionBalance(orderId).catch((e) => {
          const msg =
            e instanceof ApiRequestError
              ? `${e.message}${e.code ? ` (${e.code})` : ''}`
              : 'Не удалось загрузить балансировку';
          loadErrors.push(`Балансировка: ${msg}`);
          return null;
        })
      : Promise.resolve(null);

  await Promise.all([opsPromise, balancePromise]);
  const productionBalance = await balancePromise;

  return { operationsById, productionBalance, loadErrors };
}

// ---------------------------------------------------------------------------
// Summary block (compact, под таблицей)
// ---------------------------------------------------------------------------

function SummaryBlock({
  order,
  rows,
  productionBalance,
  logisticsTotalRub,
}: {
  order: OrderDetailDto;
  rows: OrderOperationTableRow[];
  productionBalance: OrderProductionBalanceDto | null;
  /** Σ стоимости ручных строк логистики — плюсуется в итог (см. ТЗ). */
  logisticsTotalRub: number;
}) {
  const summary = summariseOrderOperationRows(rows);
  const qty = order.qtyPlanTotal;

  // Источник истины: снимок `Order.operationCostPlanRub` /
  // `operationTimePlanSec` (его считает backend, не дублируем формулу).
  // Если snapshot пуст — берём web-side сумму.
  const snapshotCost =
    order.operationCostPlanRub != null
      ? Number(order.operationCostPlanRub)
      : null;
  const snapshotTime =
    order.operationTimePlanSec != null
      ? Number(order.operationTimePlanSec)
      : null;
  // Базовая стоимость операций: snapshot backend-а либо web-side сумма.
  const operationsCost =
    snapshotCost != null && Number.isFinite(snapshotCost)
      ? snapshotCost
      : summary.totalCostRub;
  // Логистика плюсуется к итогу. Если по операциям стоимости нет
  // (operationsCost === null), а логистика есть — итог = только логистика.
  const totalCost =
    operationsCost != null
      ? operationsCost + logisticsTotalRub
      : logisticsTotalRub > 0
        ? logisticsTotalRub
        : null;
  const totalTime =
    snapshotTime != null && Number.isFinite(snapshotTime)
      ? snapshotTime
      : summary.totalTimeSec;

  const unitCost = totalCost != null && qty > 0 ? totalCost / qty : null;
  const unitTimeSec = totalTime != null && qty > 0 ? totalTime / qty : null;

  const isStale = order.operationPlanIsStale === true;
  const staleReason = order.operationPlanStaleReason ?? null;
  const planWarnings = order.operationPlanWarnings ?? [];
  const hasAnyTotals = totalCost != null || totalTime != null;
  const bottleneckName =
    productionBalance?.bottleneckOperationName ?? summary.bottleneckOperationName;
  const recommendation =
    productionBalance?.recommendedAdditions[0] ?? null;

  return (
    <div
      className="order-operations-summary"
      data-testid="order-operations-summary"
    >
      <div className="order-operations-summary__title">Итого по операциям</div>

      {!hasAnyTotals && (
        <div className="order-operations-summary__item admin-muted">
          План операций не рассчитан.
        </div>
      )}

      {hasAnyTotals && (
        <ul className="order-operations-summary__items">
          <li
            className="order-operations-summary__item"
            data-testid="order-operations-summary-total-cost"
          >
            <span className="order-operations-summary__label">
              Стоимость операций
            </span>
            <span className="order-operations-summary__value">
              <strong>{totalCost != null ? formatRub(totalCost) : '—'}</strong>{' '}
              <span className="admin-muted">за тираж</span>
            </span>
          </li>
          <li
            className="order-operations-summary__item"
            data-testid="order-operations-summary-unit-cost"
          >
            <span className="order-operations-summary__label">
              Стоимость за 1 изделие
            </span>
            <span className="order-operations-summary__value">
              <strong>{unitCost != null ? formatRub(unitCost) : '—'}</strong>
              {unitCost != null && (
                <span className="admin-muted"> /шт</span>
              )}
            </span>
          </li>
          <li
            className="order-operations-summary__item"
            data-testid="order-operations-summary-total-time"
          >
            <span className="order-operations-summary__label">
              Плановое время
            </span>
            <span className="order-operations-summary__value">
              <strong>
                {totalTime != null ? formatDurationSec(totalTime) : '—'}
              </strong>{' '}
              <span className="admin-muted">за тираж</span>
            </span>
          </li>
          <li
            className="order-operations-summary__item"
            data-testid="order-operations-summary-unit-time"
          >
            <span className="order-operations-summary__label">
              Время на 1 изделие
            </span>
            <span className="order-operations-summary__value">
              <strong>
                {unitTimeSec != null
                  ? formatDurationSec(Math.round(unitTimeSec))
                  : '—'}
              </strong>
            </span>
          </li>
          <li
            className="order-operations-summary__item"
            data-testid="order-operations-summary-bottleneck"
          >
            <span className="order-operations-summary__label">Узкое место</span>
            <span className="order-operations-summary__value">
              {bottleneckName ? (
                <strong>{bottleneckName}</strong>
              ) : (
                <span className="admin-muted">—</span>
              )}
            </span>
          </li>
          {recommendation && (
            <li
              className="order-operations-summary__item"
              data-testid="order-operations-summary-recommendation"
            >
              <span className="order-operations-summary__label">
                Рекомендация
              </span>
              <span className="order-operations-summary__value">
                <strong>
                  +{recommendation.addWorkers} сотрудника на{' '}
                  {recommendation.operationName}
                </strong>
                {recommendation.gainPerShift != null &&
                  recommendation.gainPerShift > 0 && (
                    <span className="admin-muted">
                      {' '}
                      (+{recommendation.gainPerShift} шт/смену)
                    </span>
                  )}
              </span>
            </li>
          )}
        </ul>
      )}

      {isStale && (
        <div
          className="order-operations-summary__warning"
          data-testid="order-operations-summary-stale"
          role="status"
        >
          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden />
          <span>
            <strong>План операций требует пересчёта.</strong>
            {staleReason && <> {staleReason}</>}
          </span>
        </div>
      )}

      {planWarnings.length > 0 && !isStale && (
        <div
          className="order-operations-summary__warning"
          data-testid="order-operations-summary-warnings"
        >
          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden />
          <span>
            <strong>План операций неполный.</strong>{' '}
            {planWarnings.slice(0, 2).join(' · ')}
            {planWarnings.length > 2 && ` (+${planWarnings.length - 2})`}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export async function OrderOperationsUnifiedTable({ order, passports }: Props) {
  const data = await loadData(order.id, order.routeSteps);

  const balanceByOperationId = data.productionBalance
    ? new Map(
        data.productionBalance.lines.map((l) => [l.operationId, l] as const),
      )
    : undefined;

  const rows = buildOrderOperationRows({
    routeSteps: order.routeSteps,
    items: order.items,
    qtyPlanTotal: order.qtyPlanTotal,
    passports,
    operationsById: data.operationsById,
    balanceByOperationId,
  });

  // Ручные строки логистики идут последними строками той же таблицы
  // (см. ТЗ «строка в конце таблицы»). Стоимость плюсуется в итог.
  const logisticsLines = order.logisticsLines ?? [];
  const logisticsRows: LogisticsRow[] = logisticsLines.map((line, i) => ({
    kind: 'logistics',
    id: line.id,
    rowNumber: `Л${i + 1}`,
    line,
  }));
  const operationRows: OperationRow[] = rows.map((r) => ({
    ...r,
    kind: 'operation',
  }));
  const unifiedRows: UnifiedRow[] = [...operationRows, ...logisticsRows];

  const logisticsTotalRub = logisticsLines.reduce((acc, l) => {
    const n = Number(l.costRub);
    return Number.isFinite(n) ? acc + n : acc;
  }, 0);

  const emptyMoney = (
    <span className="order-operations-table__money order-operations-table__money--empty">
      —
    </span>
  );
  const emptyDuration = (
    <span className="order-operations-table__duration order-operations-table__duration--empty">
      —
    </span>
  );
  const emptyQty = <span className="order-operations-table__qty">—</span>;

  // Колонки таблицы: №, Операция, Статус, План, Ожидает, В работе,
  // Выполнено, Норма, Цена, Время, Стоимость, Комментарий + Действия
  // (логистика). Категории среди колонок нет (см. ТЗ §1). Каждая ячейка
  // ветвится по `kind`: операция — прежний рендер, логистика —
  // name/status/срок/стоимость, остальное «—».
  const columns: AdminTableColumn<UnifiedRow>[] = [
    {
      key: 'num',
      header: '№',
      align: 'right',
      render: (row) =>
        row.kind === 'logistics' ? (
          <span className="order-operations-table__qty">
            <strong>{row.rowNumber}</strong>
          </span>
        ) : (
          <NumberCell row={row} />
        ),
    },
    {
      key: 'operation',
      header: 'Операция',
      render: (row) =>
        row.kind === 'logistics' ? (
          <span className="order-operations-table__op-name">
            {row.line.name}{' '}
            <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
              · логистика
            </span>
          </span>
        ) : (
          <OperationCell row={row} />
        ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (row) => {
        if (row.kind === 'operation') return <StatusCell row={row} />;
        if (!row.line.status) return <span className="admin-muted">—</span>;
        return (
          <div className="order-operations-table__status">
            <AdminStatusBadge tone={logisticsStatusTone(row.line.status)}>
              {row.line.statusLabel}
            </AdminStatusBadge>
          </div>
        );
      },
    },
    {
      key: 'plan',
      header: 'План',
      align: 'right',
      render: (row) =>
        row.kind === 'logistics' ? emptyQty : <QtyCell value={row.plannedQty} />,
    },
    {
      key: 'waiting',
      header: 'Ожидает',
      align: 'right',
      render: (row) =>
        row.kind === 'logistics' ? emptyQty : <QtyCell value={row.waitingQty} />,
    },
    {
      key: 'inProgress',
      header: 'В работе',
      align: 'right',
      render: (row) =>
        row.kind === 'logistics' ? (
          emptyQty
        ) : (
          <QtyCell value={row.inProgressQty} />
        ),
    },
    {
      key: 'completed',
      header: 'Выполнено',
      align: 'right',
      render: (row) =>
        row.kind === 'logistics' ? (
          emptyQty
        ) : (
          <QtyCell value={row.completedQty} />
        ),
    },
    {
      key: 'norm',
      header: 'Норма',
      align: 'right',
      render: (row) =>
        row.kind === 'logistics' ? emptyDuration : <NormCell row={row} />,
    },
    {
      key: 'price',
      header: 'Цена',
      align: 'right',
      render: (row) =>
        row.kind === 'logistics' ? emptyMoney : <PriceCell row={row} />,
    },
    {
      key: 'time',
      header: 'Время',
      align: 'right',
      render: (row) =>
        row.kind === 'logistics' ? emptyDuration : <TimeCell row={row} />,
    },
    {
      key: 'cost',
      header: 'Стоимость',
      align: 'right',
      render: (row) =>
        row.kind === 'logistics' ? (
          <span className="order-operations-table__money">
            {formatRub(Number(row.line.costRub))}
          </span>
        ) : (
          <CostCell row={row} />
        ),
    },
    {
      key: 'comment',
      header: 'Комментарий',
      render: (row) => {
        if (row.kind === 'operation') return <CommentCell row={row} />;
        const deadline = formatLogisticsDeadline(row.line.deliveryDeadline);
        if (!deadline) {
          return (
            <span className="order-operations-table__comment order-operations-table__comment--empty">
              —
            </span>
          );
        }
        return (
          <div className="order-operations-table__comment">
            Доставка: {deadline}
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      isAction: true,
      render: (row) =>
        row.kind === 'logistics' ? (
          <OrderLogisticsRowActions orderId={order.id} line={row.line} />
        ) : null,
    },
  ];

  return (
    <div
      className="order-operations-table-card"
      data-testid="order-operations-unified-table"
    >
      <div className="order-operations-table-card__head">
        <div className="order-operations-table-card__title">Операции</div>
        <div className="order-operations-table-card__summary admin-muted">
          {rows.length === 0 ? (
            'Маршрут не выбран'
          ) : (
            <>
              <span>
                {rows.length}{' '}
                {pluralRu(rows.length, ['операция', 'операции', 'операций'])}
              </span>
              {order.techCardName && (
                <>
                  {' · '}
                  <span title="Источник: snapshot техкарты заказа.">
                    {order.techCardName}
                  </span>
                </>
              )}
              {order.routeTemplateName && (
                <>
                  {' · '}
                  <span title="Источник: snapshot маршрута заказа.">
                    {order.routeTemplateName}
                  </span>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {data.loadErrors.length > 0 && (
        <ul
          className="order-operations-table-card__errors"
          role="alert"
          data-testid="order-operations-load-errors"
        >
          {data.loadErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {unifiedRows.length === 0 ? (
        <>
          <AdminEmptyState
            title="Операций пока нет"
            hint={
              order.routeTemplateId
                ? 'У выбранного шаблона маршрута нет шагов. Откройте /admin/routes и добавьте операции.'
                : 'Выберите маршрут в редактировании заказа — план операций и их стоимость подтянутся сразу, до запуска производства.'
            }
          />
          {/* Логистику можно добавить даже без операций маршрута. */}
          <div className="order-operations-table-card__logistics-add">
            <OrderLogisticsAddButton orderId={order.id} />
          </div>
        </>
      ) : (
        <>
          <div className="order-operations-table-wrap">
            <AdminTable
              className="order-operations-table"
              rows={unifiedRows}
              columns={columns}
              rowKey={(r) => r.id}
            />
          </div>
          {/* Кнопка добавления ручной строки логистики — в конце таблицы. */}
          <div
            className="order-operations-table-card__logistics-add"
            style={{ marginTop: 8 }}
          >
            <OrderLogisticsAddButton orderId={order.id} />
          </div>
          <SummaryBlock
            order={order}
            rows={rows}
            productionBalance={data.productionBalance}
            logisticsTotalRub={logisticsTotalRub}
          />
        </>
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
