/**
 * `StockMovementsFilters` — GET-форма фильтров для вкладки «Движения»
 * раздела `/admin/warehouses?tab=movements` (см.
 * `apps/web/app/admin/warehouses/page.tsx`,
 * `apps/api/src/modules/stock/dto/list-stock-movements.dto.ts`).
 *
 * Server component: чистый HTML `<form method="get">` (тот же паттерн,
 * что у `StockBalancesFilters` / `/admin/purchase-orders`).
 *
 * Контракт:
 *   - `q` — substring по `comment` движения;
 *   - `warehouseId` — точечный фильтр по складу;
 *   - `type` — `PURCHASE_RECEIPT | MATERIAL_ISSUE | ADJUSTMENT |
 *     REVERSAL | TRANSFER` (см. `stock.constants.ts`);
 *   - `direction` — `IN | OUT`;
 *   - `from` / `to` — `<input type="date">` (`YYYY-MM-DD`),
 *     отдаются backend-у как есть; `Zod.datetime()`-валидация на
 *     backend парсит и `ISO datetime`, и `YYYY-MM-DD`;
 *   - `tab=movements` и `limit` — hidden, чтобы submit формы не
 *     сбрасывал вкладку и размер страницы. `offset` НЕ переносим —
 *     применение фильтра должно сбрасывать pagination на первую
 *     страницу.
 */
import Link from 'next/link';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
import type {
  StockMovementDirection,
  StockMovementType,
} from '@/lib/stock-api';

const MOVEMENT_TYPE_OPTIONS: ReadonlyArray<{
  value: StockMovementType;
  label: string;
}> = [
  { value: 'PURCHASE_RECEIPT', label: 'Приёмка' },
  { value: 'MATERIAL_ISSUE', label: 'Расход материалов' },
  { value: 'REVERSAL', label: 'Сторно' },
  { value: 'ADJUSTMENT', label: 'Корректировка' },
  { value: 'TRANSFER', label: 'Перемещение' },
];

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
  type?: StockMovementType;
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
          {MOVEMENT_TYPE_OPTIONS.map((o) => (
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
