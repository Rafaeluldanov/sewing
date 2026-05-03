/**
 * `WarehouseStockTabs` — переключатель видов раздела «Склады»
 * (`/admin/warehouses?tab=balances|movements`).
 *
 * UI-решение владельца проекта: вместо отдельного `/admin/stock`
 * добавить две read-only вкладки прямо в существующий список
 * складов. Вкладка `'list'` — это дефолтный вид (текущая таблица
 * складов), `tab=balances` — `GET /api/stock/balances`,
 * `tab=movements` — `GET /api/stock/movements`. Никакой mutation
 * UI на этой итерации (см. `docs/current-state.md §«UI остатков»`).
 *
 * Реализация — обычные `<Link>` на тот же путь с разным query
 * (`?tab=`). Никакого client state / `useRouter` — переключение
 * перерисовывает RSC, и серверный fetch ходит ровно за нужным
 * срезом данных (либо `listWarehouses`, либо `listStockBalances`,
 * либо `listStockMovements`).
 *
 * Стилистика — переиспользуем существующий CSS `.order-detail-tabs*`
 * (см. `apps/web/app/globals.css §«Order workspace v2 — tabs»`).
 * Это сознательная экономия: одна и та же группа «pills» уже
 * применяется в карточке заказа, добавлять новую цветовую систему
 * не нужно. Компонент `OrderViewTabs` при этом **не трогаем** —
 * мы только используем общие CSS-классы.
 */
import Link from 'next/link';

export type WarehouseStockTab = 'list' | 'balances' | 'movements';

const TAB_DEFINITIONS: ReadonlyArray<{
  id: WarehouseStockTab;
  label: string;
  href: string;
}> = [
  { id: 'list', label: 'Склады', href: '/admin/warehouses' },
  { id: 'balances', label: 'Остатки', href: '/admin/warehouses?tab=balances' },
  {
    id: 'movements',
    label: 'Движения',
    href: '/admin/warehouses?tab=movements',
  },
];

interface Props {
  activeTab: WarehouseStockTab;
}

export function WarehouseStockTabs({ activeTab }: Props) {
  return (
    <nav
      className="order-detail-tabs warehouse-stock-tabs"
      aria-label="Виды раздела «Склады»"
      role="tablist"
      data-active-tab={activeTab}
    >
      {TAB_DEFINITIONS.map((tab) => {
        const isActive = tab.id === activeTab;
        const className = [
          'order-detail-tabs__link',
          isActive ? 'order-detail-tabs__link--active' : null,
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <Link
            key={tab.id}
            href={tab.href}
            prefetch={false}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? 'page' : undefined}
            className={className}
            data-tab={tab.id}
          >
            <span className="order-detail-tabs__label">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Парсер query-параметра `tab` в строго типизированный
 * `WarehouseStockTab`. Любое незнакомое значение → `'list'`,
 * чтобы старые/битые ссылки открывались в дефолтном виде вместо
 * 404. См. `apps/web/app/admin/warehouses/page.tsx`.
 */
export function parseWarehouseStockTab(
  raw: string | string[] | undefined,
): WarehouseStockTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === 'balances' || value === 'movements') return value;
  return 'list';
}
