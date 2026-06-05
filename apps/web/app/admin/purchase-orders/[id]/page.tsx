/**
 * Карточка заказа поставщику (`/admin/purchase-orders/[id]`).
 *
 * Этап 6А «Заказы поставщикам». Структура — стандартный admin
 * detail-page:
 *   - левая колонка:
 *       1. Шапка PO (read-only snapshot поставщика, статус,
 *          ожидаемая дата);
 *       2. Форма правки шапки (`comment`, `expectedDeliveryDate`)
 *          + кнопки переходов статуса;
 *       3. Таблица строк PO с inline-формами для qty/price/eta/
 *          подтверждений.
 *   - правая колонка:
 *       4. AdminTechInfo (id, supplierId, customerOrderId, timestamps).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ExternalLink,
  ShoppingCart,
} from 'lucide-react';
import {
  PURCHASE_ORDER_STATUS_LABELS,
  type PurchaseOrderStatus,
} from '@sewing/shared/purchase-orders';
import { ApiRequestError } from '@/lib/api';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { getPurchaseOrder } from '@/lib/purchase-orders-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { EditPurchaseOrderForm } from './edit-form';
import { PurchaseOrderActionsBar } from './actions-bar';
import { PurchaseOrderLinesTable } from './lines-table';
import { PurchaseOrderReceiptsCard } from './receipts-card';

/**
 * Этап 7А «Приёмка поставок»: блок «Приёмки» в карточке PO. Гейтится
 * feature-flag-ом, чтобы на пилоте без модуля приёмки блок не
 * появлялся вовсе. Backend `/api/purchase-orders/:id/receipts`
 * остаётся доступным под `ADMIN`/`SHOP_MANAGER` в любом случае —
 * флаг гейтит только UI. Default-on (см. `isFeatureEnabled` /
 * `@/lib/feature-flags`).
 */
const FEATURE_PURCHASE_RECEIPTS_ENABLED = isFeatureEnabled(
  process.env.NEXT_PUBLIC_FEATURE_PURCHASE_RECEIPTS,
);

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
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
function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

export default async function AdminPurchaseOrderDetailPage({ params }: Params) {
  let po;
  try {
    po = await getPurchaseOrder(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  return (
    <AdminPageShell
      icon={<ShoppingCart size={22} strokeWidth={1.6} aria-hidden />}
      title={`Заказ поставщику ${po.number}`}
      subtitle={po.supplierNameSnapshot}
      actions={
        <>
          <Link
            href="/admin/purchase-orders"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
          </Link>
          {po.customerOrderId && (
            <Link
              href={`/admin/orders/${po.customerOrderId}`}
              className="admin-btn"
            >
              <ExternalLink size={16} strokeWidth={1.6} aria-hidden />
              Открыть заказ покупателя
            </Link>
          )}
          <AdminStatusBadge tone={statusTone(po.status)}>
            {formatStatus(po.status)}
          </AdminStatusBadge>
        </>
      }
    >
      <div className="admin-grid-2">
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="Шапка заказа" hint="snapshot поставщика" />
            <dl className="admin-deflist">
              <dt>Номер</dt>
              <dd>
                <strong>{po.number}</strong>
              </dd>
              <dt>Статус</dt>
              <dd>
                <AdminStatusBadge tone={statusTone(po.status)}>
                  {formatStatus(po.status)}
                </AdminStatusBadge>
              </dd>
              <dt>Поставщик</dt>
              <dd>
                <Link
                  href={`/admin/suppliers/${po.supplierId}`}
                  className="admin-table__action-link"
                >
                  <strong>{po.supplierNameSnapshot}</strong>
                </Link>
              </dd>
              <dt>Телефон</dt>
              <dd>
                {po.supplierPhoneSnapshot ?? (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Сайт</dt>
              <dd>
                {po.supplierWebsiteSnapshot ?? (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Адрес</dt>
              <dd>
                {po.supplierAddressSnapshot ?? (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Заказ покупателя</dt>
              <dd>
                {po.customerOrderId && po.customerOrderNumber ? (
                  <Link
                    href={`/admin/orders/${po.customerOrderId}`}
                    className="admin-table__action-link"
                  >
                    <strong>{po.customerOrderNumber}</strong>
                  </Link>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Ожидаемая дата</dt>
              <dd>{formatDate(po.expectedDeliveryDate)}</dd>
              <dt>Отправлено</dt>
              <dd>{formatDateTime(po.sentAt)}</dd>
              <dt>Подтверждено</dt>
              <dd>{formatDateTime(po.confirmedAt)}</dd>
              <dt>Отменено</dt>
              <dd>{formatDateTime(po.cancelledAt)}</dd>
              <dt>Сумма</dt>
              <dd>
                {po.totalAmount ? (
                  <strong>{po.totalAmount}</strong>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Комментарий</dt>
              <dd>
                {po.comment ? (
                  <span>{po.comment}</span>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
            </dl>
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Действия" />
            <PurchaseOrderActionsBar po={po} />
            <div style={{ marginTop: 16 }}>
              <EditPurchaseOrderForm po={po} />
            </div>
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader
              title="Строки заказа"
              hint={`${po.lines.length}`}
            />
            <PurchaseOrderLinesTable orderId={po.id} lines={po.lines} />
          </AdminCard>

          {FEATURE_PURCHASE_RECEIPTS_ENABLED && (
            <PurchaseOrderReceiptsCard
              purchaseOrderId={po.id}
              purchaseOrderStatus={po.status}
            />
          )}
        </div>

        <div className="admin-stack">
          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{po.id}</code> },
              { label: 'Поставщик ID', value: <code>{po.supplierId}</code> },
              {
                label: 'Заказ покупателя ID',
                value: po.customerOrderId ? (
                  <code>{po.customerOrderId}</code>
                ) : (
                  '—'
                ),
              },
              { label: 'Raw status', value: <code>{po.status}</code> },
              { label: 'Создан', value: formatDateTime(po.createdAt) },
              { label: 'Обновлён', value: formatDateTime(po.updatedAt) },
            ]}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}
