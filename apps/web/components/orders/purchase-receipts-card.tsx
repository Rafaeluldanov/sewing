/**
 * `PurchaseReceiptsCard` — блок «Поступления» в карточке заказа
 * покупателя (Этап 7А, см.
 * `apps/api/src/modules/purchase-receipts/*`,
 * `docs/recon-soft-integration.md §«Этап 7А»`).
 *
 * Серверный компонент: сам грузит список приёмок по заказу через
 * `getOrderPurchaseReceipts(orderId)`. Если backend упал —
 * показываем error-box, но карточку заказа не валим (по тем же
 * принципам, что `WorkshopNeedsCard` / `PurchaseOrdersCard`).
 *
 * MVP-минимум:
 *   - заголовок + count;
 *   - короткий список приёмок (number / supplier / status /
 *     receivedAt);
 *   - под каждой приёмкой — короткие строки `itemNameSnapshot /
 *     receivedQty / cellCode`;
 *   - ссылка «Все поступления» в `/admin/purchase-receipts?customerOrderId=…`.
 *
 * Никаких управляющих действий — отмена документа живёт в
 * `/admin/purchase-receipts/[id]`.
 */
import Link from 'next/link';
import { ArrowRight, ClipboardCheck } from 'lucide-react';
import {
  PURCHASE_RECEIPT_STATUS_LABELS,
  type PurchaseReceiptDetailDto,
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
import {
  getOrderPurchaseReceipts,
  getPurchaseReceipt,
} from '@/lib/purchase-receipts-api';
import type { AdminStatusTone } from '@/lib/admin-labels';

interface Props {
  orderId: string;
}

function statusTone(status: string): AdminStatusTone {
  switch (status as PurchaseReceiptStatus) {
    case 'DRAFT':
      return 'info';
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

export async function PurchaseReceiptsCard({ orderId }: Props) {
  let prs: PurchaseReceiptListItemDto[] = [];
  let loadError: string | null = null;
  try {
    prs = await getOrderPurchaseReceipts(orderId);
  } catch (e) {
    loadError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить поступления';
  }

  // Активные сверху, CANCELLED — в самый низ.
  const sorted = [...prs].sort((a, b) => {
    const an = a.status === 'CANCELLED' ? 1 : 0;
    const bn = b.status === 'CANCELLED' ? 1 : 0;
    if (an !== bn) return an - bn;
    return 0;
  });

  // Грузим detail по 5 верхним POSTED приёмкам, чтобы показать
  // короткую расшифровку «itemName / qty / cell». Падение — не
  // ошибка, просто рендерим без расшифровки.
  const visibleSummary = sorted.slice(0, 5);
  const detailsById = new Map<string, PurchaseReceiptDetailDto | null>();
  await Promise.all(
    visibleSummary
      .filter((p) => p.status === 'POSTED')
      .map(async (p) => {
        try {
          detailsById.set(p.id, await getPurchaseReceipt(p.id));
        } catch {
          detailsById.set(p.id, null);
        }
      }),
  );

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<ClipboardCheck size={18} strokeWidth={1.7} aria-hidden />}
        title="Поступления"
        hint={prs.length > 0 ? `${prs.length}` : undefined}
        actions={
          prs.length > 0 ? (
            <Link
              href={`/admin/purchase-receipts?customerOrderId=${encodeURIComponent(orderId)}`}
              className="admin-table__action-link"
            >
              Все поступления
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

      {prs.length === 0 ? (
        <AdminEmptyState
          icon={
            <ClipboardCheck size={26} strokeWidth={1.6} aria-hidden />
          }
          title="Поступлений ещё не было"
          hint="Они появятся, когда закупщик/кладовщик примет материал по заказу поставщику."
        />
      ) : (
        <ul className="admin-summary-list" style={{ marginTop: 8 }}>
          {visibleSummary.map((pr) => {
            const detail = detailsById.get(pr.id) ?? null;
            return (
              <li
                key={pr.id}
                style={{
                  padding: '8px 0',
                  borderTop: '1px solid rgba(0,0,0,0.06)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 12,
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
                      {pr.supplierNameSnapshot ?? '—'}
                      {' · '}Принято: {formatDateTime(pr.receivedAt)}
                    </div>
                  </div>
                  <AdminStatusBadge tone={statusTone(pr.status)}>
                    {formatStatus(pr.status)}
                  </AdminStatusBadge>
                </div>
                {detail && detail.lines.length > 0 && (
                  <ul
                    style={{
                      margin: '6px 0 0 0',
                      padding: '0 0 0 16px',
                      listStyle: 'disc',
                      fontSize: '0.78rem',
                    }}
                    className="admin-muted"
                  >
                    {detail.lines.slice(0, 6).map((l) => (
                      <li key={l.id} style={{ marginBottom: 2 }}>
                        <span style={{ color: 'var(--admin-fg)' }}>
                          {l.itemNameSnapshot}
                        </span>
                        {' — '}
                        {l.receivedQty} {l.unit}
                        {l.cellCode ? ` → ${l.cellCode}` : ''}
                        {l.warehouseName ? ` · ${l.warehouseName}` : ''}
                      </li>
                    ))}
                    {detail.lines.length > 6 && (
                      <li style={{ marginBottom: 2 }}>
                        + ещё {detail.lines.length - 6}
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
          {prs.length > visibleSummary.length && (
            <li
              style={{
                padding: '6px 0',
                borderTop: '1px solid rgba(0,0,0,0.06)',
              }}
            >
              <Link
                href={`/admin/purchase-receipts?customerOrderId=${encodeURIComponent(orderId)}`}
                className="admin-table__action-link"
              >
                + ещё {prs.length - visibleSummary.length}
                <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
              </Link>
            </li>
          )}
        </ul>
      )}
    </AdminCard>
  );
}
