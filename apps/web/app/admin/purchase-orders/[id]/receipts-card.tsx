/**
 * `ReceiptsCard` — блок «Приёмки» в карточке заказа поставщику
 * (Этап 7А, см. `apps/api/src/modules/purchase-receipts/*`).
 *
 * Серверный компонент: сам грузит список приёмок по PO через
 * `getPurchaseOrderReceipts(purchaseOrderId)`. Если backend упал —
 * показываем error-box, но карточку PO не валим.
 *
 * MVP-минимум:
 *   - заголовок + count;
 *   - короткий список приёмок (number / status / receivedAt /
 *     linesCount / суммарное receivedQty);
 *   - ссылка «Принять поступление» (на `/receive`-страницу),
 *     если статус PO разрешает приёмку;
 *   - ссылка «Все приёмки» в `/admin/purchase-receipts?purchaseOrderId=…`.
 */
import Link from 'next/link';
import { ArrowRight, ClipboardCheck } from 'lucide-react';
import {
  PURCHASE_ORDER_RECEIVABLE_STATUSES,
  type PurchaseOrderStatus,
} from '@sewing/shared/purchase-orders';
import {
  PURCHASE_RECEIPT_STATUS_LABELS,
  type PurchaseReceiptListItemDto,
  type PurchaseReceiptStatus,
} from '@sewing/shared/purchase-receipts';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import { ApiRequestError } from '@/lib/api';
import { getPurchaseOrderReceipts } from '@/lib/purchase-receipts-api';
import type { AdminStatusTone } from '@/lib/admin-labels';

interface Props {
  purchaseOrderId: string;
  purchaseOrderStatus: PurchaseOrderStatus | string;
}

function statusTone(status: string): AdminStatusTone {
  switch (status as PurchaseReceiptStatus) {
    case 'POSTED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}

function formatStatus(status: string): string {
  return (
    PURCHASE_RECEIPT_STATUS_LABELS[status as PurchaseReceiptStatus] ?? status
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

export async function PurchaseOrderReceiptsCard({
  purchaseOrderId,
  purchaseOrderStatus,
}: Props) {
  let receipts: PurchaseReceiptListItemDto[] = [];
  let loadError: string | null = null;
  try {
    receipts = await getPurchaseOrderReceipts(purchaseOrderId);
  } catch (e) {
    loadError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить приёмки';
  }

  const canReceive = (
    PURCHASE_ORDER_RECEIVABLE_STATUSES as readonly string[]
  ).includes(purchaseOrderStatus);

  // Активные сверху, CANCELLED — в самый низ.
  const sorted = [...receipts].sort((a, b) => {
    const an = a.status === 'CANCELLED' ? 1 : 0;
    const bn = b.status === 'CANCELLED' ? 1 : 0;
    if (an !== bn) return an - bn;
    return 0;
  });

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<ClipboardCheck size={18} strokeWidth={1.7} aria-hidden />}
        title="Приёмки"
        hint={receipts.length > 0 ? `${receipts.length}` : undefined}
        actions={
          <div className="admin-actions-row" style={{ gap: 8 }}>
            {canReceive && (
              <Link
                href={`/admin/purchase-orders/${purchaseOrderId}/receive`}
                className="admin-btn admin-btn--primary"
              >
                <ClipboardCheck
                  size={16}
                  strokeWidth={1.6}
                  aria-hidden
                />
                Принять поступление
              </Link>
            )}
            {receipts.length > 0 && (
              <Link
                href={`/admin/purchase-receipts?purchaseOrderId=${encodeURIComponent(purchaseOrderId)}`}
                className="admin-table__action-link"
              >
                Все приёмки
                <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
              </Link>
            )}
          </div>
        }
      />

      {loadError && (
        <div className="error-box" role="alert" style={{ marginBottom: 8 }}>
          {loadError}
        </div>
      )}

      {receipts.length === 0 ? (
        <AdminEmptyState
          icon={
            <ClipboardCheck size={26} strokeWidth={1.6} aria-hidden />
          }
          title="Приёмок ещё не было"
          hint={
            canReceive
              ? 'Зарегистрируйте первую приёмку кнопкой выше.'
              : 'Приёмка станет доступна после отправки/подтверждения заказа.'
          }
        />
      ) : (
        <ul className="admin-summary-list" style={{ marginTop: 8 }}>
          {sorted.map((pr) => (
            <li
              key={pr.id}
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
                    href={`/admin/purchase-receipts/${pr.id}`}
                    className="admin-table__action-link"
                  >
                    {pr.number}
                  </Link>
                </div>
                <div
                  className="admin-muted"
                  style={{ fontSize: '0.78rem', marginTop: 2 }}
                >
                  Принято: {formatDateTime(pr.receivedAt)}
                  {' · '}Строк: {pr.linesCount}
                  {pr.totalReceivedQty
                    ? ` · Σ: ${pr.totalReceivedQty}`
                    : ''}
                </div>
              </div>
              <AdminStatusBadge tone={statusTone(pr.status)}>
                {formatStatus(pr.status)}
              </AdminStatusBadge>
            </li>
          ))}
        </ul>
      )}
    </AdminCard>
  );
}
