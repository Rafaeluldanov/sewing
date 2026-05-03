/**
 * `StockMovementsTable` — read-only журнал движений
 * `StockMovement` для вкладки `?tab=movements` раздела «Склады».
 *
 * Server-component: получает уже загруженный массив items и
 * рендерит `<AdminTable>`. `description` в response движений
 * нет (backend на этой итерации не отдаёт — `sourceKey`
 * сознательно скрыт), поэтому колонка «Материал» собирается
 * из `workshopNeedId` или `sourceId` (см. ТЗ §7).
 *
 * Никаких mutation-кнопок — журнал read-only. `sourceKey`
 * (внутренний идемпотентный ключ `PURCHASE_RECEIPT_LINE:<id>`,
 * `MATERIAL_ISSUE_LINE:<id>`) сознательно не показываем — backend
 * его в публичном response не возвращает (см. JSDoc сервиса).
 */
import {
  AdminEmptyState,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import type { StockMovementListItem } from '@/lib/stock-api';
import { Activity } from 'lucide-react';
import {
  formatStockDateTime,
  formatStockMoney,
  formatStockQty,
} from './format';
import { StockDirectionBadge } from './stock-direction-badge';
import { StockMovementTypeBadge } from './stock-movement-type-badge';

interface Props {
  items: StockMovementListItem[];
}

/**
 * Источник движения для колонки «Источник» — компактная
 * подпись `<sourceType> <sourceId>` или fallback на пустую
 * прочерк-ячейку. `sourceType` это внешний классификатор
 * (например, `PURCHASE_RECEIPT_LINE`); `sourceId` — id строки
 * исходного документа. Полные id не обрезаем — UI ширина
 * горизонтального скролла это допускает.
 */
function formatSource(item: StockMovementListItem): string {
  const parts: string[] = [];
  if (item.sourceType) parts.push(item.sourceType);
  if (item.sourceId) parts.push(item.sourceId);
  if (parts.length === 0) return '—';
  return parts.join(' · ');
}

/**
 * Подпись материала для колонки «Материал». Backend не отдаёт
 * `description` в movement-response (есть только в balance), поэтому
 * fallback-цепочка: `workshopNeedId` → `sourceId` → `«—»`. Эта
 * подпись управленческая: «по чему движение», без дублирования
 * полной справочной информации (она доступна на вкладке «Остатки»
 * по тому же `workshopNeedId`).
 */
function formatMaterial(item: StockMovementListItem): string {
  if (item.workshopNeedId) return item.workshopNeedId;
  if (item.sourceId) return item.sourceId;
  return '—';
}

export function StockMovementsTable({ items }: Props) {
  if (items.length === 0) {
    return (
      <AdminEmptyState
        icon={<Activity size={26} strokeWidth={1.6} aria-hidden />}
        title="Движения материалов пока не зафиксированы."
        hint="Они появятся после первой приёмки или расхода материалов."
      />
    );
  }

  const columns: AdminTableColumn<StockMovementListItem>[] = [
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
      key: 'material',
      header: 'Материал',
      render: (m) => (
        <span className="admin-muted admin-stock-cell__hint">
          {formatMaterial(m)}
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
          {formatSource(m)}
        </span>
      ),
    },
    {
      key: 'comment',
      header: 'Комментарий',
      render: (m) =>
        m.comment ? <span>{m.comment}</span> : <span className="admin-muted">—</span>,
    },
  ];

  return <AdminTable rows={items} columns={columns} rowKey={(m) => m.id} />;
}
