/**
 * `StockBalancesTable` — read-only таблица текущих остатков
 * `StockBalance` для вкладки `?tab=balances` раздела «Склады».
 *
 * Server-component: получает уже загруженный массив items и
 * рендерит `<AdminTable>`. Сам ничего не fetch-ит — это делает
 * страница `/admin/warehouses/page.tsx` через
 * `listStockBalances(...)`. Никаких mutation-кнопок (списание /
 * корректировка / перемещение между ячейками) — UI полностью
 * read-only (см. ТЗ §11).
 *
 * Колонки совпадают с `StockBalanceListItem` из
 * `apps/web/lib/stock-api.ts` (тот же shape, что отдаёт
 * `StockService::toStockBalanceListItem`):
 *   - Материал / описание (`description` + lookups);
 *   - Заказ (`orderNumber` или короткий `orderId`);
 *   - Склад / Ячейка (если данных нет — `«—»`);
 *   - Кол-во + ед. изм. (`qty`, `unit`);
 *   - Цена / Сумма (`unitCost`, `totalCost`);
 *   - Последнее движение (`lastMovementAt`);
 *   - Обновлено (`updatedAt`).
 *
 * Подсветка отрицательного остатка: при `qty < 0` строка
 * получает класс `admin-table__row--danger`. CSS-новый не
 * вводим — используем существующее `data-state="danger"`-стиль
 * через inline-style (чтобы не зависеть от CSS-классов, которых
 * может не быть). При `qty < 0` колонка «Кол-во» дополнительно
 * получает `<AdminStatusBadge tone="danger">` с числом — так
 * красная подсветка считывается даже без таблично-уровневых
 * стилей.
 */
import {
  AdminEmptyState,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import type { StockBalanceListItem } from '@/lib/stock-api';
import { Warehouse } from 'lucide-react';
import {
  formatStockDateTime,
  formatStockMoney,
  formatStockQty,
  toStockNumber,
} from './format';

interface Props {
  items: StockBalanceListItem[];
}

export function StockBalancesTable({ items }: Props) {
  if (items.length === 0) {
    return (
      <AdminEmptyState
        icon={<Warehouse size={26} strokeWidth={1.6} aria-hidden />}
        title="Остатки материалов пока не сформированы."
        hint="Они появятся, когда будет проведена приёмка или расход материалов."
      />
    );
  }

  const columns: AdminTableColumn<StockBalanceListItem>[] = [
    {
      key: 'description',
      header: 'Материал',
      render: (b) => (
        <div className="admin-stock-cell">
          <span className="admin-table__primary">{b.description}</span>
          {b.materialRole && (
            <span className="admin-muted admin-stock-cell__hint">
              {b.materialRole}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'order',
      header: 'Заказ',
      render: (b) =>
        b.orderNumber ? (
          <span>{b.orderNumber}</span>
        ) : b.orderId ? (
          <span className="admin-muted">{b.orderId}</span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'warehouse',
      header: 'Склад',
      render: (b) =>
        b.warehouseName ? (
          <span>{b.warehouseName}</span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'cell',
      header: 'Ячейка',
      render: (b) =>
        b.cellCode ? (
          <span>{b.cellCode}</span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'qty',
      header: 'Кол-во',
      align: 'right',
      render: (b) => {
        const n = toStockNumber(b.qty);
        if (n < 0) {
          return (
            <AdminStatusBadge tone="danger">
              {formatStockQty(b.qty)}
            </AdminStatusBadge>
          );
        }
        return formatStockQty(b.qty);
      },
    },
    {
      key: 'unit',
      header: 'Ед. изм.',
      render: (b) => b.unit || <span className="admin-muted">—</span>,
    },
    {
      key: 'unitCost',
      header: 'Цена',
      align: 'right',
      render: (b) => formatStockMoney(b.unitCost),
    },
    {
      key: 'totalCost',
      header: 'Сумма',
      align: 'right',
      render: (b) => formatStockMoney(b.totalCost),
    },
    {
      key: 'lastMovementAt',
      header: 'Последнее движение',
      render: (b) => formatStockDateTime(b.lastMovementAt),
    },
    {
      key: 'updatedAt',
      header: 'Обновлено',
      render: (b) => formatStockDateTime(b.updatedAt),
    },
  ];

  return <AdminTable rows={items} columns={columns} rowKey={(b) => b.id} />;
}
