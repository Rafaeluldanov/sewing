/**
 * `FinishedGoodsShipmentsTable` — read-only таблица «История отгрузок
 * готовой продукции по заказу» в секции отгрузки карточки заказа
 * (`/admin/orders/[id]?tab=production`).
 *
 * Server-component, источник истины —
 * `GET /api/orders/:orderId/finished-goods-shipments` (см.
 * `apps/web/lib/finished-goods-api.ts::listOrderFinishedGoodsShipments`).
 *
 * Каждая строка раскрывается в список номенклатуры (productName /
 * color / sizeCode + qty + warehouse / cell). Для статуса
 * `POSTED` доступна inline-кнопка «Отменить» (см.
 * `CancelFinishedGoodsShipmentButton`); для статуса `CANCELLED`
 * показывается badge «Отменена» + причина отмены и дата. Cancelled
 * строки сознательно НЕ скрываются — они остаются в истории.
 */
import { Ban, Truck } from 'lucide-react';
import {
  AdminEmptyState,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import type { FinishedGoodsShipmentDetailDto } from '@/lib/finished-goods-api';
import { CancelFinishedGoodsShipmentButton } from './cancel-finished-goods-shipment-button';

interface Props {
  orderId: string;
  /** ADMIN / SHOP_MANAGER — определяет видимость кнопки «Отменить». */
  canManage: boolean;
  items: FinishedGoodsShipmentDetailDto[];
}

function formatLineName(line: FinishedGoodsShipmentDetailDto['lines'][number]): string {
  const product = line.productName ?? line.productId;
  const size = line.sizeCode ?? line.sizeId;
  const parts: string[] = [];
  if (product) parts.push(product);
  if (line.color) parts.push(line.color);
  if (size) parts.push(size);
  return parts.join(' / ');
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function FinishedGoodsShipmentsTable({
  orderId,
  canManage,
  items,
}: Props) {
  if (items.length === 0) {
    return (
      <AdminEmptyState
        icon={<Truck size={26} strokeWidth={1.6} aria-hidden />}
        title="Отгрузок по заказу ещё не было"
        hint="Создайте отгрузку, чтобы списать готовую продукцию со склада."
      />
    );
  }

  const columns: AdminTableColumn<FinishedGoodsShipmentDetailDto>[] = [
    {
      key: 'shippedAt',
      header: 'Дата отгрузки',
      render: (s) => formatDate(s.shippedAt),
    },
    {
      key: 'number',
      header: 'Номер',
      render: (s) => <span className="admin-table__primary">{s.number}</span>,
    },
    {
      key: 'status',
      header: 'Статус',
      render: (s) => {
        if (s.status === 'CANCELLED') {
          return (
            <div data-status="CANCELLED">
              <AdminStatusBadge tone="danger">
                <Ban
                  size={12}
                  strokeWidth={1.6}
                  aria-hidden
                  style={{ marginRight: 4, verticalAlign: 'middle' }}
                />
                Отменена
              </AdminStatusBadge>
              {s.cancelledAt && (
                <div
                  className="admin-muted"
                  style={{ fontSize: '0.8rem', marginTop: 2 }}
                >
                  {formatDate(s.cancelledAt)}
                </div>
              )}
              {s.cancelReason && (
                <div
                  className="admin-muted"
                  style={{ fontSize: '0.8rem', marginTop: 2 }}
                  title={s.cancelReason}
                >
                  Причина: {s.cancelReason}
                </div>
              )}
            </div>
          );
        }
        return (
          <div data-status="POSTED">
            <AdminStatusBadge tone="success">Проведена</AdminStatusBadge>
          </div>
        );
      },
    },
    {
      key: 'lines',
      header: 'Номенклатура',
      render: (s) => (
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {s.lines.map((line) => (
            <li key={line.id}>
              <span>{formatLineName(line)}</span>
              <span className="admin-muted">
                {' '}
                — {line.qty.toLocaleString('ru-RU')} шт
                {line.warehouseName ? ` · ${line.warehouseName}` : ''}
                {line.cellCode ? ` / ${line.cellCode}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: 'totalQty',
      header: 'Всего, шт',
      align: 'right',
      render: (s) =>
        s.lines.reduce((acc, l) => acc + l.qty, 0).toLocaleString('ru-RU'),
    },
    {
      key: 'comment',
      header: 'Комментарий',
      render: (s) =>
        s.comment ? <span>{s.comment}</span> : <span className="admin-muted">—</span>,
    },
    {
      key: 'actions',
      header: '',
      isAction: true,
      render: (s) => {
        if (!canManage) return null;
        if (s.status !== 'POSTED') return null;
        return (
          <CancelFinishedGoodsShipmentButton
            orderId={orderId}
            shipmentId={s.id}
            shipmentNumber={s.number}
          />
        );
      },
    },
  ];

  return <AdminTable rows={items} columns={columns} rowKey={(s) => s.id} />;
}
