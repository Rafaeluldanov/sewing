/**
 * `StockBalancesTable` — read-only таблица текущих остатков для
 * вкладки `?tab=balances` раздела «Склады» (см.
 * `apps/web/app/admin/warehouses/page.tsx`).
 *
 * Server-component: получает уже загруженный массив unified-строк
 * (`UnifiedWarehouseBalanceRow`) и рендерит `<AdminTable>`. Сам ничего
 * не fetch-ит — это делает страница, которая объединяет ответы
 * `listStockBalances` (материалы) и `listFinishedGoodsBalances`
 * (готовая продукция) через mappers (`unified-rows.ts`).
 *
 * UI-решение владельца проекта: материалы и готовая продукция
 * показываются в одной таблице. Готовая продукция различается по
 * шаблону имени `productName / color / sizeCode` — отдельной колонки
 * «Тип» не вводим. Цена / сумма для готовой продукции — `«—»`,
 * потому что это не material cost.
 *
 * Никаких mutation-кнопок (списание / корректировка / перемещение
 * между ячейками) внутри таблицы — UI полностью read-only. Кнопки
 * `StockTransferButton` / `StockAdjustmentButton` на странице
 * работают только с материалами и фильтруют список отдельно.
 */
import {
  AdminEmptyState,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { Warehouse } from 'lucide-react';
import {
  formatStockDateTime,
  formatStockMoney,
  formatStockQty,
  toStockNumber,
} from './format';
import type { UnifiedWarehouseBalanceRow } from './unified-rows';

interface Props {
  items: UnifiedWarehouseBalanceRow[];
}

export function StockBalancesTable({ items }: Props) {
  if (items.length === 0) {
    return (
      <AdminEmptyState
        icon={<Warehouse size={26} strokeWidth={1.6} aria-hidden />}
        title="Остатки пока не сформированы."
        hint="Они появятся, когда будет проведена приёмка / расход материалов или выпуск готовой продукции."
      />
    );
  }

  const columns: AdminTableColumn<UnifiedWarehouseBalanceRow>[] = [
    {
      key: 'name',
      header: 'Номенклатура',
      render: (b) => (
        <div className="admin-stock-cell" data-row-kind={b.kind}>
          <span className="admin-table__primary">{b.name}</span>
          {b.hint && (
            <span className="admin-muted admin-stock-cell__hint">{b.hint}</span>
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
