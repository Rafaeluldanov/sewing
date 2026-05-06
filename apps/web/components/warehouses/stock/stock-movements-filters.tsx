/**
 * `StockMovementsFilters` — GET-форма фильтров для вкладки «Движения»
 * раздела `/admin/warehouses?tab=movements` (см.
 * `apps/web/app/admin/warehouses/page.tsx`,
 * `apps/api/src/modules/stock/dto/list-stock-movements.dto.ts`,
 * `apps/api/src/modules/finished-goods/dto/list-finished-goods-movements.dto.ts`).
 *
 * Server component: чистый HTML `<form method="get">` (тот же паттерн,
 * что у `StockBalancesFilters` / `/admin/purchase-orders`).
 *
 * UI-решение владельца проекта: вкладка «Движения» теперь показывает
 * и материалы, и готовую продукцию в одной таблице. Поэтому select
 * «Тип движения» расширен типами готовой продукции (`PRODUCTION_RECEIPT`)
 * и сторно/корректировка/перемещение становятся «общими» (есть и у
 * материалов, и у ГП). `SHIPMENT` пока не показываем — отгрузка не
 * реализована.
 *
 * Контракт:
 *   - `q` — substring по `comment` движения (применяется только к
 *     материальному API; finished goods backend `q` не принимает);
 *   - `warehouseId` — точечный фильтр по складу;
 *   - `type` — расширенный union:
 *       `PURCHASE_RECEIPT | MATERIAL_ISSUE` (только материалы);
 *       `PRODUCTION_RECEIPT` (только готовая продукция);
 *       `REVERSAL | ADJUSTMENT | TRANSFER` (общие);
 *   - `direction` — `IN | OUT`;
 *   - `from` / `to` — `<input type="date">` (`YYYY-MM-DD`),
 *     отдаются backend-у как есть;
 *   - `tab=movements` и `limit` — hidden, чтобы submit формы не
 *     сбрасывал вкладку и размер страницы. `offset` НЕ переносим —
 *     применение фильтра должно сбрасывать pagination на первую
 *     страницу.
 */
import Link from 'next/link';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
import type { StockMovementDirection } from '@/lib/stock-api';

/**
 * Объединённый union типов движений для UI. На MVP-итерации
 * unified-вкладка не показывает `SHIPMENT` (отгрузка готовой
 * продукции ещё не реализована).
 */
export type UnifiedMovementType =
  | 'PURCHASE_RECEIPT'
  | 'MATERIAL_ISSUE'
  | 'PRODUCTION_RECEIPT'
  | 'REVERSAL'
  | 'ADJUSTMENT'
  | 'TRANSFER';

/**
 * В какой backend-API уходит запрос для выбранного типа.
 * `material-only` / `finished-goods-only` позволяют пропустить
 * лишний fetch на странице. `shared` — оба API (REVERSAL / ADJUSTMENT
 * / TRANSFER встречаются и в материалах, и в готовой продукции).
 * `all` — type не выбран, нужны оба API.
 */
export type UnifiedMovementScope =
  | 'material-only'
  | 'finished-goods-only'
  | 'shared'
  | 'all';

export const UNIFIED_MOVEMENT_TYPE_OPTIONS: ReadonlyArray<{
  value: UnifiedMovementType;
  label: string;
  scope: UnifiedMovementScope;
}> = [
  { value: 'PURCHASE_RECEIPT', label: 'Приёмка', scope: 'material-only' },
  {
    value: 'MATERIAL_ISSUE',
    label: 'Списание материалов',
    scope: 'material-only',
  },
  { value: 'PRODUCTION_RECEIPT', label: 'Выпуск', scope: 'finished-goods-only' },
  { value: 'REVERSAL', label: 'Сторно', scope: 'shared' },
  { value: 'ADJUSTMENT', label: 'Корректировка', scope: 'shared' },
  { value: 'TRANSFER', label: 'Перемещение', scope: 'shared' },
];

const UNIFIED_TYPE_VALUES: ReadonlySet<UnifiedMovementType> = new Set(
  UNIFIED_MOVEMENT_TYPE_OPTIONS.map((o) => o.value),
);

/**
 * Парсер `searchParams.type` → известный union, либо `undefined`.
 * `SHIPMENT` сознательно отбрасывается: отгрузка не реализована и
 * фильтр UI её не показывает.
 */
export function parseUnifiedMovementType(
  raw: string | undefined,
): UnifiedMovementType | undefined {
  if (!raw) return undefined;
  return UNIFIED_TYPE_VALUES.has(raw as UnifiedMovementType)
    ? (raw as UnifiedMovementType)
    : undefined;
}

/**
 * Маршрутизация UI-типа в backend-API. Используется страницей
 * `BalancesTabPage` / `MovementsTabPage` для пропуска лишних
 * fetch-ей.
 */
export function routeMovementTypeToScope(
  type: UnifiedMovementType | undefined,
): UnifiedMovementScope {
  if (!type) return 'all';
  const opt = UNIFIED_MOVEMENT_TYPE_OPTIONS.find((o) => o.value === type);
  return opt?.scope ?? 'all';
}

const DIRECTION_OPTIONS: ReadonlyArray<{
  value: StockMovementDirection;
  label: string;
}> = [
  { value: 'IN', label: 'Приход' },
  { value: 'OUT', label: 'Расход' },
];

interface Props {
  /** Текущие значения фильтра (из `searchParams`). */
  q?: string;
  warehouseId?: string;
  type?: UnifiedMovementType;
  direction?: StockMovementDirection;
  from?: string;
  to?: string;
  /** Текущий `limit`, чтобы submit формы не сбрасывал размер страницы. */
  limit: number;
  /** Список активных складов для select-а. */
  warehouses: WarehouseSummaryDto[];
}

export function StockMovementsFilters({
  q,
  warehouseId,
  type,
  direction,
  from,
  to,
  limit,
  warehouses,
}: Props) {
  const isFiltered =
    Boolean(q) ||
    Boolean(warehouseId) ||
    Boolean(type) ||
    Boolean(direction) ||
    Boolean(from) ||
    Boolean(to);

  return (
    <form
      action="/admin/warehouses"
      method="get"
      className="admin-form-grid"
      style={{ marginTop: 4 }}
      data-stock-filters="movements"
      aria-label="Фильтры движений"
    >
      <input type="hidden" name="tab" value="movements" />
      <input type="hidden" name="limit" value={String(limit)} />

      <div className="admin-field">
        <label htmlFor="stockMovementsQ">Поиск</label>
        <input
          id="stockMovementsQ"
          name="q"
          type="search"
          defaultValue={q ?? ''}
          placeholder="Комментарий, источник, материал"
        />
      </div>

      <div className="admin-field">
        <label htmlFor="stockMovementsWarehouse">Склад</label>
        <select
          id="stockMovementsWarehouse"
          name="warehouseId"
          defaultValue={warehouseId ?? ''}
        >
          <option value="">Все склады</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.code ? ` (${w.code})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="admin-field">
        <label htmlFor="stockMovementsType">Тип движения</label>
        <select
          id="stockMovementsType"
          name="type"
          defaultValue={type ?? ''}
        >
          <option value="">Все типы</option>
          {UNIFIED_MOVEMENT_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="admin-field">
        <label htmlFor="stockMovementsDirection">Направление</label>
        <select
          id="stockMovementsDirection"
          name="direction"
          defaultValue={direction ?? ''}
        >
          <option value="">Все</option>
          {DIRECTION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="admin-field">
        <label htmlFor="stockMovementsFrom">Период с</label>
        <input
          id="stockMovementsFrom"
          name="from"
          type="date"
          defaultValue={from ?? ''}
        />
      </div>

      <div className="admin-field">
        <label htmlFor="stockMovementsTo">Период по</label>
        <input
          id="stockMovementsTo"
          name="to"
          type="date"
          defaultValue={to ?? ''}
        />
      </div>

      <div className="admin-actions-row" style={{ alignItems: 'end' }}>
        <button type="submit" className="admin-btn">
          Применить
        </button>
        {isFiltered && (
          <Link
            href="/admin/warehouses?tab=movements"
            className="admin-btn admin-btn--ghost"
          >
            Сбросить
          </Link>
        )}
      </div>
    </form>
  );
}
