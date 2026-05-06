import Link from 'next/link';
import { Activity, ArrowRight, Plus, Warehouse } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { listWarehouses } from '@/lib/warehouses-api';
import {
  listStockBalances,
  listStockMovements,
  STOCK_LIST_DEFAULT_LIMIT,
  STOCK_LIST_MAX_LIMIT,
  type StockBalanceListResponse,
  type StockMovementListResponse,
  type StockMovementDirection,
} from '@/lib/stock-api';
import {
  listFinishedGoodsBalances,
  listFinishedGoodsMovements,
  type FinishedGoodsBalanceListResponse,
  type FinishedGoodsMovementListResponse,
} from '@/lib/finished-goods-api';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminStatusBadge,
  AdminTable,
  paginate,
  type AdminTableColumn,
} from '@/components/admin';
import { formatStatus, statusTone } from '@/lib/admin-labels';
import {
  applyUnifiedPagination,
  finishedGoodsBalanceToUnified,
  finishedGoodsMovementToUnified,
  materialBalanceToUnified,
  materialMovementToUnified,
  parseStockBalanceState,
  parseUnifiedMovementType,
  parseWarehouseStockTab,
  routeMovementTypeToScope,
  sortUnifiedBalances,
  sortUnifiedMovements,
  StockAdjustmentButton,
  StockBalancesFilters,
  StockBalancesTable,
  StockMovementsFilters,
  StockMovementsTable,
  StockPagination,
  StockTransferButton,
  stockStateToApiFlags,
  WAREHOUSES_UNIFIED_FETCH_LIMIT,
  WarehouseStockTabs,
  type StockBalanceState,
  type UnifiedWarehouseBalanceRow,
  type UnifiedWarehouseMovementRow,
  type WarehouseStockTab,
} from '@/components/warehouses/stock';

export const dynamic = 'force-dynamic';

interface SearchParams {
  /** Активная вкладка раздела «Склады»: `list` (default) | `balances` | `movements`. */
  tab?: string;
  /** Pagination для дефолтной вкладки `list` (handled by `paginate()`). */
  page?: string;
  pageSize?: string;
  /** Pagination для read-only API склада (`limit/offset`). */
  limit?: string;
  offset?: string;
  /** Лёгкий поиск; для остатков прокидывается в оба API, для движений
   * только в material API (finished goods backend `q` не принимает). */
  q?: string;
  /** Точечный фильтр по складу (для обеих вкладок). */
  warehouseId?: string;
  /**
   * Единый UI-параметр над тремя backend-флагами
   * `positiveOnly` / `negativeOnly` / `zeroOnly` для вкладки
   * `balances`. Принимает `'all' | 'positive' | 'zero' | 'negative'`.
   */
  stockState?: string;
  /** Только для вкладки `movements`. */
  type?: string;
  direction?: string;
  from?: string;
  to?: string;
  /**
   * Legacy: backend-флаги напрямую — оставляем поддержку для обратной
   * совместимости URL-ов до введения единого `stockState`-селекта.
   */
  positiveOnly?: string;
  negativeOnly?: string;
  zeroOnly?: string;
}

/**
 * `/admin/warehouses` — раздел «Склады».
 *
 * UI-решение владельца проекта: вместо отдельной страницы
 * `/admin/finished-goods` или нового пункта sidebar — три вкладки
 * прямо здесь:
 *   - `list` (default) — текущая таблица складов;
 *   - `balances` — объединённые остатки материалов
 *     (`GET /api/stock/balances`) и готовой продукции
 *     (`GET /api/finished-goods/balances`), read-only;
 *   - `movements` — объединённый журнал движений
 *     (`GET /api/stock/movements` + `GET /api/finished-goods/movements`),
 *     read-only.
 *
 * Никаких mutation-actions для готовой продукции в UI на этой
 * итерации — только чтение в существующих вкладках. Backend остаётся
 * раздельным; merge делается в RSC через mappers
 * (`unified-rows.ts`).
 *
 * **TODO (backend unified endpoint).** На больших объёмах двойной
 * fetch + UI-merge не масштабируется. Лучшее решение — серверный
 * unified warehouse endpoint с общим total / pagination / sorting.
 */
export default async function AdminWarehousesListPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const activeTab: WarehouseStockTab = parseWarehouseStockTab(searchParams?.tab);

  const headerActions = (
    <>
      <WarehouseStockTabs activeTab={activeTab} />
      <Link
        href="/admin/warehouses/new"
        className="admin-btn admin-btn--primary"
      >
        <Plus size={16} strokeWidth={1.6} aria-hidden />
        Добавить
      </Link>
    </>
  );

  if (activeTab === 'balances') {
    return (
      <BalancesTabPage
        searchParams={searchParams ?? {}}
        headerActions={headerActions}
      />
    );
  }
  if (activeTab === 'movements') {
    return (
      <MovementsTabPage
        searchParams={searchParams ?? {}}
        headerActions={headerActions}
      />
    );
  }
  return (
    <WarehousesListTabPage
      searchParams={searchParams ?? {}}
      headerActions={headerActions}
    />
  );
}

// ---------------------------------------------------------------------------
// Tab: «Склады» (default) — существующая таблица складов.
// ---------------------------------------------------------------------------

async function WarehousesListTabPage({
  searchParams,
  headerActions,
}: {
  searchParams: SearchParams;
  headerActions: React.ReactNode;
}) {
  let items: WarehouseSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listWarehouses();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список складов';
  }

  const { pageItems, page, pageSize, total } = paginate(items, searchParams);

  const columns: AdminTableColumn<WarehouseSummaryDto>[] = [
    {
      key: 'name',
      header: 'Название',
      render: (w) => <span className="admin-table__primary">{w.name}</span>,
    },
    {
      key: 'cells',
      header: 'Ячеек',
      align: 'right',
      render: (w) =>
        w.cellsCount === 0 ? (
          <span className="admin-muted">0</span>
        ) : (
          w.cellsCount
        ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (w) => (
        <AdminStatusBadge tone={statusTone(w.isActive)}>
          {formatStatus(w.isActive)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (w) => (
        <Link
          href={`/admin/warehouses/${w.id}`}
          className="admin-table__action-link"
        >
          Открыть
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      ),
    },
  ];

  return (
    <AdminPageShell
      icon={<Warehouse size={22} strokeWidth={1.6} aria-hidden />}
      title="Склады"
      subtitle={`Всего: ${items.length}`}
      actions={headerActions}
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminTable
          rows={pageItems}
          columns={columns}
          rowKey={(w) => w.id}
          emptyContent={
            <AdminEmptyState
              icon={<Warehouse size={26} strokeWidth={1.6} aria-hidden />}
              title="Складов пока нет"
              hint="Создайте первый склад — это займёт меньше минуты."
              actions={
                <Link
                  href="/admin/warehouses/new"
                  className="admin-btn admin-btn--primary"
                >
                  <Plus size={16} strokeWidth={1.6} aria-hidden />
                  Добавить склад
                </Link>
              }
            />
          }
        />

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/warehouses"
          label="складов"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

// ---------------------------------------------------------------------------
// Tab: «Остатки» — материалы + готовая продукция в одной таблице.
// ---------------------------------------------------------------------------

async function BalancesTabPage({
  searchParams,
  headerActions,
}: {
  searchParams: SearchParams;
  headerActions: React.ReactNode;
}) {
  const limit = parseLimit(searchParams.limit);
  const offset = parseOffset(searchParams.offset);
  const q = sanitizeString(searchParams.q);
  const warehouseId = sanitizeString(searchParams.warehouseId);
  const stockState: StockBalanceState = parseStockBalanceState(
    searchParams.stockState,
  );
  const stateFromFlags = parseLegacyStockState({
    positiveOnly: searchParams.positiveOnly,
    negativeOnly: searchParams.negativeOnly,
    zeroOnly: searchParams.zeroOnly,
  });
  const effectiveStockState: StockBalanceState =
    stockState === 'all' && stateFromFlags ? stateFromFlags : stockState;
  const apiFlags = stockStateToApiFlags(effectiveStockState);

  // На MVP объединяем два независимых backend-API на UI-уровне.
  // Запрашиваем оба с потолком `WAREHOUSES_UNIFIED_FETCH_LIMIT`,
  // объединяем, сортируем и применяем UI-pagination над общим
  // массивом. `total` — сумма backend-total-ов.
  // TODO: Для больших объёмов лучше сделать backend unified
  // warehouse endpoint с серверным total / pagination / sorting.
  let materialResp: StockBalanceListResponse | null = null;
  let finishedResp: FinishedGoodsBalanceListResponse | null = null;
  let error: string | null = null;
  let warehouses: WarehouseSummaryDto[] = [];
  try {
    [materialResp, finishedResp, warehouses] = await Promise.all([
      listStockBalances({
        q,
        warehouseId,
        ...apiFlags,
        limit: WAREHOUSES_UNIFIED_FETCH_LIMIT,
        offset: 0,
      }),
      listFinishedGoodsBalances({
        q,
        warehouseId,
        ...apiFlags,
        limit: WAREHOUSES_UNIFIED_FETCH_LIMIT,
        offset: 0,
      }),
      listWarehouses(),
    ]);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить остатки склада';
  }

  const materialItems = materialResp?.items ?? [];
  const finishedItems = finishedResp?.items ?? [];
  const total = (materialResp?.total ?? 0) + (finishedResp?.total ?? 0);

  const unified: UnifiedWarehouseBalanceRow[] = sortUnifiedBalances([
    ...materialItems.map(materialBalanceToUnified),
    ...finishedItems.map(finishedGoodsBalanceToUnified),
  ]);
  const pageRows = applyUnifiedPagination(unified, offset, limit);

  const balancesPreserve: Record<string, string | undefined> = {
    tab: 'balances',
    q,
    warehouseId,
    stockState: effectiveStockState !== 'all' ? effectiveStockState : undefined,
  };

  return (
    <AdminPageShell
      icon={<Warehouse size={22} strokeWidth={1.6} aria-hidden />}
      title="Склады"
      subtitle={`Остатки: ${total}`}
      actions={headerActions}
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <StockBalancesFilters
          q={q}
          warehouseId={warehouseId}
          stockState={effectiveStockState}
          limit={limit}
          warehouses={warehouses}
        />
      </AdminCard>

      <AdminCard>
        {/* Mutation-кнопки работают только с материалами — у готовой
         * продукции своя транзакционная модель (через PackingService /
         * Operation flag), отдельных adjustment / transfer не ввели. */}
        {materialItems.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
              padding: '0 0 8px 0',
            }}
          >
            <StockTransferButton
              balances={materialItems}
              warehouses={warehouses}
            />
            <StockAdjustmentButton balances={materialItems} />
          </div>
        )}
        <StockBalancesTable items={pageRows} />
        <StockPagination
          basePath="/admin/warehouses"
          total={total}
          limit={limit}
          offset={offset}
          preserveParams={balancesPreserve}
          label="остатков"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

// ---------------------------------------------------------------------------
// Tab: «Движения» — материалы + готовая продукция в одном журнале.
// ---------------------------------------------------------------------------

async function MovementsTabPage({
  searchParams,
  headerActions,
}: {
  searchParams: SearchParams;
  headerActions: React.ReactNode;
}) {
  const limit = parseLimit(searchParams.limit);
  const offset = parseOffset(searchParams.offset);
  const q = sanitizeString(searchParams.q);
  const warehouseId = sanitizeString(searchParams.warehouseId);
  const type = parseUnifiedMovementType(sanitizeString(searchParams.type));
  const direction = parseMovementDirection(searchParams.direction);
  const from = sanitizeDate(searchParams.from);
  const to = sanitizeDate(searchParams.to);
  const scope = routeMovementTypeToScope(type);

  // Type routing — пропускаем лишний fetch, если тип специфичен для
  // одного контура. `material-only` (PURCHASE_RECEIPT / MATERIAL_ISSUE)
  // не идёт в finished goods API; `finished-goods-only`
  // (PRODUCTION_RECEIPT) не идёт в material API. `shared`
  // (REVERSAL / ADJUSTMENT / TRANSFER) и `all` — оба API.
  const wantsMaterial = scope === 'all' || scope === 'shared' || scope === 'material-only';
  const wantsFinished =
    scope === 'all' || scope === 'shared' || scope === 'finished-goods-only';

  let materialResp: StockMovementListResponse | null = null;
  let finishedResp: FinishedGoodsMovementListResponse | null = null;
  let error: string | null = null;
  let warehouses: WarehouseSummaryDto[] = [];
  try {
    [materialResp, finishedResp, warehouses] = await Promise.all([
      wantsMaterial
        ? listStockMovements({
            q,
            warehouseId,
            // Передаём type только если он валиден для материального API.
            type:
              type === 'PURCHASE_RECEIPT' ||
              type === 'MATERIAL_ISSUE' ||
              type === 'REVERSAL' ||
              type === 'ADJUSTMENT' ||
              type === 'TRANSFER'
                ? type
                : undefined,
            direction,
            from,
            to,
            limit: WAREHOUSES_UNIFIED_FETCH_LIMIT,
            offset: 0,
          })
        : Promise.resolve(null),
      wantsFinished
        ? listFinishedGoodsMovements({
            warehouseId,
            // Finished goods API не принимает `q` (DTO `.strict()`),
            // поэтому в этот контур поиск не уходит.
            type:
              type === 'PRODUCTION_RECEIPT' ||
              type === 'SHIPMENT' ||
              type === 'REVERSAL' ||
              type === 'ADJUSTMENT' ||
              type === 'TRANSFER'
                ? type
                : undefined,
            direction,
            from,
            to,
            limit: WAREHOUSES_UNIFIED_FETCH_LIMIT,
            offset: 0,
          })
        : Promise.resolve(null),
      listWarehouses(),
    ]);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить журнал движений склада';
  }

  const materialItems = materialResp?.items ?? [];
  const finishedItems = finishedResp?.items ?? [];
  const total = (materialResp?.total ?? 0) + (finishedResp?.total ?? 0);

  // TODO: Для больших объёмов лучше сделать backend unified
  // warehouse endpoint с серверным total / pagination / sorting.
  const unified: UnifiedWarehouseMovementRow[] = sortUnifiedMovements([
    ...materialItems.map(materialMovementToUnified),
    ...finishedItems.map(finishedGoodsMovementToUnified),
  ]);
  const pageRows = applyUnifiedPagination(unified, offset, limit);

  const movementsPreserve: Record<string, string | undefined> = {
    tab: 'movements',
    q,
    warehouseId,
    type,
    direction,
    from,
    to,
  };

  return (
    <AdminPageShell
      icon={<Activity size={22} strokeWidth={1.6} aria-hidden />}
      title="Склады"
      subtitle={`Движений: ${total}`}
      actions={headerActions}
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <StockMovementsFilters
          q={q}
          warehouseId={warehouseId}
          type={type}
          direction={direction}
          from={from}
          to={to}
          limit={limit}
          warehouses={warehouses}
        />
      </AdminCard>

      <AdminCard>
        <StockMovementsTable items={pageRows} />
        <StockPagination
          basePath="/admin/warehouses"
          total={total}
          limit={limit}
          offset={offset}
          preserveParams={movementsPreserve}
          label="движений"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

// ---------------------------------------------------------------------------
// Search-param parsers.
// ---------------------------------------------------------------------------

function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return STOCK_LIST_DEFAULT_LIMIT;
  if (n > STOCK_LIST_MAX_LIMIT) return STOCK_LIST_MAX_LIMIT;
  return n;
}

function parseOffset(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

function sanitizeString(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function sanitizeDate(raw: string | undefined): string | undefined {
  return sanitizeString(raw);
}

function parseLegacyStockState(raw: {
  positiveOnly?: string;
  negativeOnly?: string;
  zeroOnly?: string;
}): StockBalanceState | null {
  const isTrue = (v: string | undefined) => v === 'true' || v === '1';
  if (isTrue(raw.positiveOnly)) return 'positive';
  if (isTrue(raw.negativeOnly)) return 'negative';
  if (isTrue(raw.zeroOnly)) return 'zero';
  return null;
}

function parseMovementDirection(
  raw: string | undefined,
): StockMovementDirection | undefined {
  if (raw === 'IN' || raw === 'OUT') return raw;
  return undefined;
}
