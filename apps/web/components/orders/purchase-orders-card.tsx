/**
 * `PurchaseOrdersCard` — блок «Заказы поставщикам» в карточке заказа
 * покупателя (Этап 6А, см.
 * `apps/api/src/modules/purchase-orders/*`,
 * `docs/recon-soft-integration.md §«Этап 6А»`).
 *
 * Серверный компонент: сам грузит список PO по заказу через
 * `getOrderPurchaseOrders(orderId)`. Если backend упал — показываем
 * error-box, но карточку заказа не валим (по тем же принципам, что
 * `WorkshopNeedsCard`).
 *
 * MVP-минимум:
 *   - заголовок + count;
 *   - короткий список PO (number / supplier / status / ETA / linesCount);
 *   - ссылка «Все заказы поставщикам» в `/admin/purchase-orders?customerOrderId=…`.
 *
 * Никаких управляющих действий тут нет — все переходы статусов
 * (Send/Confirm/Cancel) живут в карточке самого PO
 * (`/admin/purchase-orders/[id]`).
 */
import Link from 'next/link';
import { ArrowRight, ShoppingCart } from 'lucide-react';
import {
  PURCHASE_ORDER_STATUS_LABELS,
  type PurchaseOrderListItemDto,
  type PurchaseOrderStatus,
} from '@sewing/shared/purchase-orders';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import { ClickableCard } from '@/components/ui/clickable-card';
import { ApiRequestError, errorText } from '@/lib/api';
import { getOrderPurchaseOrders } from '@/lib/purchase-orders-api';
import type { AdminStatusTone } from '@/lib/admin-labels';

interface Props {
  orderId: string;
}

function statusTone(status: string): AdminStatusTone {
  switch (status as PurchaseOrderStatus) {
    case 'DRAFT':
      return 'info';
    case 'SENT':
      return 'warning';
    case 'CONFIRMED':
      return 'success';
    case 'PARTIALLY_RECEIVED':
      return 'warning';
    case 'RECEIVED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}

function formatStatus(status: string): string {
  return (
    PURCHASE_ORDER_STATUS_LABELS[status as PurchaseOrderStatus] ?? status
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU');
}

export async function PurchaseOrdersCard({ orderId }: Props) {
  let pos: PurchaseOrderListItemDto[] = [];
  let loadError: string | null = null;
  try {
    pos = await getOrderPurchaseOrders(orderId);
  } catch (e) {
    loadError =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить заказы поставщикам';
  }

  // Активные PO идут первыми; CANCELLED — в самый низ.
  const sorted = [...pos].sort((a, b) => {
    const an = a.status === 'CANCELLED' ? 1 : 0;
    const bn = b.status === 'CANCELLED' ? 1 : 0;
    if (an !== bn) return an - bn;
    return 0;
  });
  const visible = sorted.slice(0, 6);

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<ShoppingCart size={18} strokeWidth={1.7} aria-hidden />}
        title="Заказы поставщикам"
        hint={pos.length > 0 ? `${pos.length}` : undefined}
        actions={
          pos.length > 0 ? (
            <Link
              href={`/admin/purchase-orders?customerOrderId=${encodeURIComponent(orderId)}`}
              className="admin-table__action-link"
            >
              Все заказы
              <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
            </Link>
          ) : undefined
        }
      />

      {loadError && (
        <div className="error-box" role="alert" style={{ marginBottom: 8 }}>
          {loadError}
        </div>
      )}

      {pos.length === 0 ? (
        <AdminEmptyState
          icon={<ShoppingCart size={26} strokeWidth={1.6} aria-hidden />}
          title="Заказов поставщикам пока нет"
          hint="Создание идёт из карточки потребности цеха кнопкой «Создать заказ поставщику»."
        />
      ) : (
        <ul className="admin-summary-list" style={{ marginTop: 8 }}>
          {visible.map((po) => (
            <ClickableCard
              key={po.id}
              as="li"
              href={`/admin/purchase-orders/${po.id}`}
              ariaLabel={`Заказ поставщику ${po.number}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 12,
                padding: '6px 0',
                borderTop: '1px solid rgba(0,0,0,0.06)',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 500 }}>
                  <Link
                    href={`/admin/purchase-orders/${po.id}`}
                    className="admin-table__action-link"
                  >
                    {po.number}
                  </Link>
                </div>
                <div
                  className="admin-muted"
                  style={{ fontSize: '0.78rem', marginTop: 2 }}
                >
                  {po.supplierNameSnapshot}
                  {' · '}Строк: {po.linesCount}
                  {po.expectedDeliveryDate
                    ? ` · Ожидается: ${formatDate(po.expectedDeliveryDate)}`
                    : ''}
                  {po.totalAmount ? ` · Сумма: ${po.totalAmount}` : ''}
                </div>
              </div>
              <AdminStatusBadge tone={statusTone(po.status)}>
                {formatStatus(po.status)}
              </AdminStatusBadge>
            </ClickableCard>
          ))}
          {pos.length > visible.length && (
            <li
              style={{
                padding: '6px 0',
                borderTop: '1px solid rgba(0,0,0,0.06)',
              }}
            >
              <Link
                href={`/admin/purchase-orders?customerOrderId=${encodeURIComponent(orderId)}`}
                className="admin-table__action-link"
              >
                + ещё {pos.length - visible.length}
                <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
              </Link>
            </li>
          )}
        </ul>
      )}
    </AdminCard>
  );
}
