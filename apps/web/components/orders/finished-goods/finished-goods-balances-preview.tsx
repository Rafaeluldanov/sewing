/**
 * `FinishedGoodsBalancesPreview` — read-only таблица «Доступная
 * готовая продукция по заказу» в секции отгрузки. Это оперативная
 * сводка для менеджера: он видит, что есть на остатке прямо сейчас и
 * сколько можно отгрузить.
 *
 * Server-component, источник истины — `GET /api/finished-goods/balances?orderId=…`
 * (см. `apps/web/lib/finished-goods-api.ts::listFinishedGoodsBalances`).
 * Имя строки — `productName / color / sizeCode` (тот же шаблон, что в
 * `/admin/warehouses?tab=balances`, см.
 * `apps/web/components/warehouses/stock/unified-rows.ts`).
 */
import {
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import type { FinishedGoodsBalanceListItem } from '@/lib/finished-goods-api';

interface Props {
  balances: FinishedGoodsBalanceListItem[];
}

function formatName(b: FinishedGoodsBalanceListItem): string {
  const product = b.productName ?? b.productId;
  const size = b.sizeCode ?? b.sizeId;
  const parts: string[] = [];
  if (product) parts.push(product);
  if (b.color) parts.push(b.color);
  if (size) parts.push(size);
  return parts.join(' / ');
}

export function FinishedGoodsBalancesPreview({ balances }: Props) {
  const columns: AdminTableColumn<FinishedGoodsBalanceListItem>[] = [
    {
      key: 'name',
      header: 'Номенклатура',
      render: (b) => <span className="admin-table__primary">{formatName(b)}</span>,
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
      header: 'Доступно',
      align: 'right',
      render: (b) => (
        <span>
          {b.qty.toLocaleString('ru-RU')}
          <span className="admin-muted"> шт</span>
        </span>
      ),
    },
  ];

  return <AdminTable rows={balances} columns={columns} rowKey={(b) => b.id} />;
}
