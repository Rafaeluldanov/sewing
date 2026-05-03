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
  parseWarehouseStockTab,
  StockBalancesTable,
  StockMovementsTable,
  StockPagination,
  WarehouseStockTabs,
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
  /** Только для вкладки `movements`. */
  type?: string;
  direction?: string;
  /** Взаимоисключающие флаги для вкладки `balances`. */
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
  const positiveOnly = parseBoolean(searchParams.positiveOnly);
  const negativeOnly = parseBoolean(searchParams.negativeOnly);
  const zeroOnly = parseBoolean(searchParams.zeroOnly);

  let response: StockBalanceListResponse | null = null;
  let error: string | null = null;
  try {
    response = await listStockBalances({
      q,
      positiveOnly,
      negativeOnly,
      zeroOnly,
      limit,
      offset,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить остатки склада';
  }

  const total = response?.total ?? 0;
  const items = response?.items ?? [];

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
        <StockBalancesTable items={items} />
        <StockPagination
          basePath="/admin/warehouses"
          total={total}
          limit={response?.limit ?? limit}
          offset={response?.offset ?? offset}
          preserveParams={{
            tab: 'balances',
            q,
            positiveOnly: positiveOnly ? 'true' : undefined,
            negativeOnly: negativeOnly ? 'true' : undefined,
            zeroOnly: zeroOnly ? 'true' : undefined,
          }}
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
  const type = parseMovementType(searchParams.type);
  const direction = parseMovementDirection(searchParams.direction);

  let response: StockMovementListResponse | null = null;
  let error: string | null = null;
  try {
    response = await listStockMovements({
      q,
      type,
      direction,
      limit,
      offset,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить журнал движений склада';
  }

  const total = response?.total ?? 0;
  const items = response?.items ?? [];

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
        <StockMovementsTable items={items} />
        <StockPagination
          basePath="/admin/warehouses"
          total={total}
          limit={response?.limit ?? limit}
          offset={response?.offset ?? offset}
          preserveParams={{
            tab: 'movements',
            q,
            type,
            direction,
          }}
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

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === 'true' || raw === '1') return true;
  return undefined;
}

function sanitizeString(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

const MOVEMENT_TYPES: ReadonlySet<StockMovementType> = new Set<StockMovementType>([
  'PURCHASE_RECEIPT',
  'MATERIAL_ISSUE',
  'ADJUSTMENT',
  'REVERSAL',
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
