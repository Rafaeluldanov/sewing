/**
 * `StockBalancesFilters` — GET-форма фильтров для вкладки «Остатки»
 * раздела `/admin/warehouses?tab=balances` (см.
 * `apps/web/app/admin/warehouses/page.tsx`,
 * `apps/api/src/modules/stock/dto/list-stock-balances.dto.ts`).
 *
 * Server component: чистый HTML `<form method="get">`. Submit
 * отправляет браузером — RSC перерисовывает страницу со свежими
 * `searchParams`. Не используем client state / `useRouter` — тот же
 * паттерн, что у `/admin/purchase-orders`, `/admin/clients` и т.п.
 *
 * Контракт:
 *   - `q` — substring по описанию остатка / WorkshopNeed;
 *   - `warehouseId` — точечный фильтр по складу (select из активных);
 *   - `stockState` — единый UI-параметр над тремя backend-флагами
 *     `positiveOnly` / `negativeOnly` / `zeroOnly`. UI исключает
 *     возможность выбрать несколько mutually-exclusive значений сразу;
 *   - `tab=balances` и `limit` хранятся в скрытых input-ах, чтобы
 *     submit формы не сбрасывал вкладку и size страницы;
 *   - `offset` НЕ переносим — применение фильтра должно сбрасывать
 *     pagination на первую страницу.
 *
 * Кнопка «Сбросить» — обычная ссылка на
 * `/admin/warehouses?tab=balances`, без хранения текущего `limit`
 * (после сброса оставляем дефолтные 50 — это поведение совпадает с
 * `purchase-orders`).
 */
import Link from 'next/link';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';

export type StockBalanceState = 'all' | 'positive' | 'zero' | 'negative';

const STOCK_STATE_OPTIONS: ReadonlyArray<{
  value: StockBalanceState;
  label: string;
}> = [
  { value: 'all', label: 'Все' },
  { value: 'positive', label: 'Положительные' },
  { value: 'zero', label: 'Нулевые' },
  { value: 'negative', label: 'Отрицательные' },
];

interface Props {
  /** Текущие значения фильтра (из `searchParams`). */
  q?: string;
  warehouseId?: string;
  stockState: StockBalanceState;
  /** Текущий `limit`, чтобы submit формы не сбрасывал размер страницы. */
  limit: number;
  /** Список активных складов для select-а. */
  warehouses: WarehouseSummaryDto[];
}

export function StockBalancesFilters({
  q,
  warehouseId,
  stockState,
  limit,
  warehouses,
}: Props) {
  const isFiltered =
    Boolean(q) ||
    Boolean(warehouseId) ||
    (stockState && stockState !== 'all');

  return (
    <form
      action="/admin/warehouses"
      method="get"
      className="admin-form-grid"
      style={{ marginTop: 4 }}
      data-stock-filters="balances"
      aria-label="Фильтры остатков"
    >
      {/* Сохраняем вкладку и размер страницы; offset сознательно не переносим. */}
      <input type="hidden" name="tab" value="balances" />
      <input type="hidden" name="limit" value={String(limit)} />

      <div className="admin-field">
        <label htmlFor="stockBalancesQ">Поиск</label>
        <input
          id="stockBalancesQ"
          name="q"
          type="search"
          defaultValue={q ?? ''}
          placeholder="Материал, описание, заказ"
        />
      </div>

      <div className="admin-field">
        <label htmlFor="stockBalancesWarehouse">Склад</label>
        <select
          id="stockBalancesWarehouse"
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
        <label htmlFor="stockBalancesState">Остаток</label>
        <select
          id="stockBalancesState"
          name="stockState"
          defaultValue={stockState}
        >
          {STOCK_STATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="admin-actions-row" style={{ alignItems: 'end' }}>
        <button type="submit" className="admin-btn">
          Применить
        </button>
        {isFiltered && (
          <Link
            href="/admin/warehouses?tab=balances"
            className="admin-btn admin-btn--ghost"
          >
            Сбросить
          </Link>
        )}
      </div>
    </form>
  );
}

/**
 * Парсер UI-параметра `stockState` из `searchParams`. Любое незнакомое
 * значение → `'all'`, чтобы битые/устаревшие ссылки не падали.
 */
export function parseStockBalanceState(
  raw: string | string[] | undefined,
): StockBalanceState {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === 'positive' || value === 'zero' || value === 'negative') {
    return value;
  }
  return 'all';
}

/**
 * Маппинг UI-`stockState` → пара backend-флагов
 * `positiveOnly` / `negativeOnly` / `zeroOnly`. UI исключает
 * mutual-exclusive конфликт — за раз ставится максимум один флаг.
 */
export function stockStateToApiFlags(state: StockBalanceState): {
  positiveOnly?: boolean;
  negativeOnly?: boolean;
  zeroOnly?: boolean;
} {
  switch (state) {
    case 'positive':
      return { positiveOnly: true };
    case 'zero':
      return { zeroOnly: true };
    case 'negative':
      return { negativeOnly: true };
    default:
      return {};
  }
}
