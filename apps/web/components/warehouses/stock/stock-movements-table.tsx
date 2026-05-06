/**
 * `StockMovementsTable` — read-only журнал движений для вкладки
 * `?tab=movements` раздела «Склады» (см.
 * `apps/web/app/admin/warehouses/page.tsx`).
 *
 * Server-component: получает уже загруженный массив unified-строк
 * (`UnifiedWarehouseMovementRow`). Сам ничего не fetch-ит — страница
 * объединяет ответы `listStockMovements` (материалы) и
 * `listFinishedGoodsMovements` (готовая продукция) через mappers
 * (`unified-rows.ts`).
 *
 * `sourceKey` (внутренний идемпотентный ключ) сознательно не
 * показываем — backend его в публичном response не возвращает. Для
 * движений готовой продукции «Источник» собирается из `passportId` /
 * `boxId`; для материалов — из `sourceType` · `sourceId`.
 */
import {
  AdminEmptyState,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { Activity } from 'lucide-react';
import {
  formatStockDateTime,
  formatStockMoney,
  formatStockQty,
} from './format';
import { StockDirectionBadge } from './stock-direction-badge';
import { StockMovementTypeBadge } from './stock-movement-type-badge';
import type { UnifiedWarehouseMovementRow } from './unified-rows';

interface Props {
  items: UnifiedWarehouseMovementRow[];
}

/**
 * Подпись «Источник» в зависимости от типа строки. Для материалов
 * это `sourceType · sourceId` (ровно как в предыдущем UI). Для
 * готовой продукции — `passportId` и/или `boxId`, потому что
 * движение с `type = PRODUCTION_RECEIPT` всегда привязано к
 * паспорту (см. `FinishedGoodsService.recordPassportOutputInTx`).
 */
function formatUnifiedSource(item: UnifiedWarehouseMovementRow): string {
  const parts: string[] = [];
  if (item.kind === 'FINISHED_GOOD') {
    if (item.passportId) parts.push(`паспорт ${item.passportId}`);
    if (item.boxId) parts.push(`коробка ${item.boxId}`);
  } else {
    if (item.sourceType) parts.push(item.sourceType);
    if (item.sourceId) parts.push(item.sourceId);
  }
  if (parts.length === 0) return '—';
  return parts.join(' · ');
}

export function StockMovementsTable({ items }: Props) {
  if (items.length === 0) {
    return (
      <AdminEmptyState
        icon={<Activity size={26} strokeWidth={1.6} aria-hidden />}
        title="Движения пока не зафиксированы."
        hint="Они появятся после первой приёмки / расхода материалов или выпуска готовой продукции."
      />
    );
  }

  const columns: AdminTableColumn<UnifiedWarehouseMovementRow>[] = [
    {
      key: 'createdAt',
      header: 'Дата',
      render: (m) => formatStockDateTime(m.createdAt),
    },
    {
      key: 'type',
      header: 'Тип',
      render: (m) => <StockMovementTypeBadge type={m.type} />,
    },
    {
      key: 'direction',
      header: 'Направление',
      render: (m) => <StockDirectionBadge direction={m.direction} />,
    },
    {
      key: 'name',
      header: 'Номенклатура',
      render: (m) => (
        <span data-row-kind={m.kind}>
          {m.name || <span className="admin-muted">—</span>}
        </span>
      ),
    },
    {
      key: 'order',
      header: 'Заказ',
      render: (m) =>
        m.orderNumber ? (
          <span>{m.orderNumber}</span>
        ) : m.orderId ? (
          <span className="admin-muted">{m.orderId}</span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    // Колонка «Заказчик» — `Client.name` через `Order.client` (см.
    // `apps/api/src/modules/stock/stock.service.ts::toStockMovementListItem`,
    // `apps/api/src/modules/finished-goods/finished-goods.service.ts::toMovementListItem`).
    {
      key: 'client',
      header: 'Заказчик',
      render: (m) =>
        m.clientName ? (
          <span>{m.clientName}</span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'warehouse',
      header: 'Склад',
      render: (m) =>
        m.warehouseName ? (
          <span>{m.warehouseName}</span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'cell',
      header: 'Ячейка',
      render: (m) =>
        m.cellCode ? (
          <span>{m.cellCode}</span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'qty',
      header: 'Кол-во',
      align: 'right',
      render: (m) => (
        <span>
          {formatStockQty(m.qty)}
          {m.unit ? <span className="admin-muted"> {m.unit}</span> : null}
        </span>
      ),
    },
    {
      key: 'unitCost',
      header: 'Цена',
      align: 'right',
      render: (m) => formatStockMoney(m.unitCost),
    },
    {
      key: 'totalCost',
      header: 'Сумма',
      align: 'right',
      render: (m) => formatStockMoney(m.totalCost),
    },
    {
      key: 'balanceBefore',
      header: 'Остаток до',
      align: 'right',
      render: (m) => formatStockQty(m.balanceBeforeQty),
    },
    {
      key: 'balanceAfter',
      header: 'Остаток после',
      align: 'right',
      render: (m) => formatStockQty(m.balanceAfterQty),
    },
    {
      key: 'source',
      header: 'Источник',
      render: (m) => (
        <span className="admin-muted admin-stock-cell__hint">
          {formatUnifiedSource(m)}
        </span>
      ),
    },
    {
      key: 'comment',
      header: 'Комментарий',
      render: (m) =>
        m.comment ? (
          <span>{m.comment}</span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
  ];

  return <AdminTable rows={items} columns={columns} rowKey={(m) => m.id} />;
}
