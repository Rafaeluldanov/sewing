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
  type StockMovementType,
} from '@/lib/stock-api';
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
  parseStockBalanceState,
  parseWarehouseStockTab,
  StockAdjustmentButton,
  StockBalancesFilters,
  StockBalancesTable,
  StockMovementsFilters,
  StockMovementsTable,
  StockPagination,
  StockTransferButton,
  stockStateToApiFlags,
  WarehouseStockTabs,
  type StockBalanceState,
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
  /** Лёгкий поиск; backend применяет `q` и в balances, и в movements. */
  q?: string;
  /** Точечный фильтр по складу (для обеих вкладок). */
  warehouseId?: string;
  /**
   * Единый UI-параметр над тремя backend-флагами
   * `positiveOnly` / `negativeOnly` / `zeroOnly` для вкладки
   * `balances` (см. `StockBalancesFilters`). Принимает
   * `'all' | 'positive' | 'zero' | 'negative'`. Любое незнакомое
   * значение → `'all'`.
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
   * Из формы фильтра больше не отправляются.
   */
  positiveOnly?: string;
  negativeOnly?: string;
  zeroOnly?: string;
}

/**
 * `/admin/warehouses` — раздел «Склады».
 *
 * UI-решение владельца проекта (см. ТЗ «show stock balances and
 * movements tabs»): вместо отдельной страницы `/admin/stock` или
 * нового пункта sidebar — три вкладки прямо здесь:
 *   - `list` (default) — текущая таблица складов;
 *   - `balances` — `GET /api/stock/balances`, read-only;
 *   - `movements` — `GET /api/stock/movements`, read-only.
 *
 * Никаких mutation-actions в UI на этой итерации (см.
 * `apps/api/src/modules/stock/stock.controller.ts` — backend тоже
 * read-only). Multi-warehouse фильтр / сводки по складам / FIFO/LIFO /
 * корректировки остатков **не реализованы** — это сознательная
 * граница итерации (см. `docs/current-state.md`).
 *
 * Backend / DTO не меняем — frontend ходит через
 * `apps/web/lib/stock-api.ts` (`apiFetch`-обёртка с cookie-форвардом
 * из `next/headers`, ровно как остальные admin pages).
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
// Tab: «Остатки» — `GET /api/stock/balances`.
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
  // Новый единый UI-параметр «Остаток» — `'all' | 'positive' | 'zero'
  // | 'negative'` (см. `StockBalancesFilters`). Маппится в три
  // backend-флага через `stockStateToApiFlags`.
  const stockState: StockBalanceState = parseStockBalanceState(
    searchParams.stockState,
  );
  // Legacy: если URL пришёл со старыми флагами (`positiveOnly=true`
  // и т.п.) — продолжаем их уважать, но новый UI больше не отдаёт.
  const stateFromFlags = parseLegacyStockState({
    positiveOnly: searchParams.positiveOnly,
    negativeOnly: searchParams.negativeOnly,
    zeroOnly: searchParams.zeroOnly,
  });
  const effectiveStockState: StockBalanceState =
    stockState === 'all' && stateFromFlags ? stateFromFlags : stockState;
  const apiFlags = stockStateToApiFlags(effectiveStockState);

  let response: StockBalanceListResponse | null = null;
  let error: string | null = null;
  let warehouses: WarehouseSummaryDto[] = [];
  try {
    // Параллельно: остатки + список складов (нужен и для select-а
    // назначения в `StockTransferDialog`, и для select-а склада в
    // `StockBalancesFilters`).
    [response, warehouses] = await Promise.all([
      listStockBalances({
        q,
        warehouseId,
        ...apiFlags,
        limit,
        offset,
      }),
      listWarehouses(),
    ]);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить остатки склада';
  }

  const total = response?.total ?? 0;
  const items = response?.items ?? [];

  // Параметры, которые нужно сохранять при переходе по pagination и
  // переключении страниц pagination — submit формы фильтров их
  // регенерирует, но pagination сама про них ничего не знает.
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

      {/*
       * Фильтры остатков (см.
       * `apps/web/components/warehouses/stock/stock-balances-filters.tsx`).
       * Отдельная `AdminCard` над таблицей — submit формы перерисует
       * страницу со свежими `searchParams`. Кнопки «Корректировка» /
       * «Переместить» остаются над таблицей внутри основной карточки.
       */}
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
        {items.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
              padding: '0 0 8px 0',
            }}
          >
            <StockTransferButton balances={items} warehouses={warehouses} />
            <StockAdjustmentButton balances={items} />
          </div>
        )}
        <StockBalancesTable items={items} />
        <StockPagination
          basePath="/admin/warehouses"
          total={total}
          limit={response?.limit ?? limit}
          offset={response?.offset ?? offset}
          preserveParams={balancesPreserve}
          label="остатков"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

// ---------------------------------------------------------------------------
// Tab: «Движения» — `GET /api/stock/movements`.
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
  const type = parseMovementType(searchParams.type);
  const direction = parseMovementDirection(searchParams.direction);
  const from = sanitizeDate(searchParams.from);
  const to = sanitizeDate(searchParams.to);

  let response: StockMovementListResponse | null = null;
  let error: string | null = null;
  let warehouses: WarehouseSummaryDto[] = [];
  try {
    [response, warehouses] = await Promise.all([
      listStockMovements({
        q,
        warehouseId,
        type,
        direction,
        from,
        to,
        limit,
        offset,
      }),
      listWarehouses(),
    ]);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить журнал движений склада';
  }

  const total = response?.total ?? 0;
  const items = response?.items ?? [];

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

      {/*
       * Фильтры журнала движений (см.
       * `apps/web/components/warehouses/stock/stock-movements-filters.tsx`).
       */}
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
        <StockMovementsTable items={items} />
        <StockPagination
          basePath="/admin/warehouses"
          total={total}
          limit={response?.limit ?? limit}
          offset={response?.offset ?? offset}
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

/**
 * `<input type="date">` отдаёт `YYYY-MM-DD` или пустую строку.
 * Прокидываем backend-у как есть — `Zod.datetime()` на DTO принимает
 * ISO-формат, а сам сервис строит `Date` из строки. Пустая строка /
 * undefined → не отправляем фильтр.
 */
function sanitizeDate(raw: string | undefined): string | undefined {
  return sanitizeString(raw);
}

/**
 * Legacy-парсер старых backend-флагов в URL (`positiveOnly=true` и
 * т.п.). Новый UI отдаёт единый `stockState`, но если кто-то открыл
 * старую ссылку — продолжаем уважать её. Возвращает соответствующий
 * `StockBalanceState` или `null`, если ни один флаг не установлен.
 */
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

const MOVEMENT_TYPES: ReadonlySet<StockMovementType> = new Set<StockMovementType>([
  'PURCHASE_RECEIPT',
  'MATERIAL_ISSUE',
  'ADJUSTMENT',
  'REVERSAL',
  'TRANSFER',
]);

function parseMovementType(raw: string | undefined): StockMovementType | undefined {
  if (raw == null) return undefined;
  return MOVEMENT_TYPES.has(raw as StockMovementType)
    ? (raw as StockMovementType)
    : undefined;
}

function parseMovementDirection(
  raw: string | undefined,
): StockMovementDirection | undefined {
  if (raw === 'IN' || raw === 'OUT') return raw;
  return undefined;
}
