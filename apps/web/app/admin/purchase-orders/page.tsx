/**
 * Список заказов поставщикам (`/admin/purchase-orders`).
 *
 * Этап 6А «Заказы поставщикам» (см. `docs/recon-soft-integration.md
 * §«Этап 6А»`). Закупочный документ без приёмки и без склада:
 * объединяет одну или несколько `WorkshopNeed`, фиксирует supplier
 * snapshot и item-snapshots по строкам.
 *
 * Backend: `GET /api/purchase-orders` (см.
 * `apps/api/src/modules/purchase-orders/*`). Никакой пагинации на
 * сервере не делаем — на MVP-объёмах список помещается одним
 * запросом, paginate-им через `paginate(...)` уже на клиенте.
 *
 * RBAC и feature-flag: страница доступна только под
 * `ADMIN`/`SHOP_MANAGER` (sidebar показывает пункт только при
 * `NEXT_PUBLIC_FEATURE_PURCHASE_ORDERS=1`).
 */
import Link from 'next/link';
import { ArrowRight, ShoppingCart } from 'lucide-react';
import {
  PURCHASE_ORDER_STATUSES,
  PURCHASE_ORDER_STATUS_LABELS,
  type PurchaseOrderListItemDto,
  type PurchaseOrderStatus,
} from '@sewing/shared/purchase-orders';
import {
  SUPPLIER_STATUS_LABELS,
  type SupplierListItemDto,
  type SupplierStatus,
} from '@sewing/shared/suppliers';
import { ApiRequestError } from '@/lib/api';
import { listPurchaseOrders } from '@/lib/purchase-orders-api';
import { listSuppliers } from '@/lib/suppliers-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  paginate,
  type AdminTableColumn,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  pageSize?: string;
  search?: string;
  status?: string;
  supplierId?: string;
  customerOrderId?: string;
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

export default async function AdminPurchaseOrdersPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const search = searchParams?.search?.trim();
  const supplierId = searchParams?.supplierId?.trim();
  const customerOrderId = searchParams?.customerOrderId?.trim();
  const statusRaw = searchParams?.status?.trim();
  const status =
    statusRaw &&
    (PURCHASE_ORDER_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as PurchaseOrderStatus)
      : undefined;

  let items: PurchaseOrderListItemDto[] = [];
  let error: string | null = null;
  try {
    items = await listPurchaseOrders({
      search: search || undefined,
      status,
      supplierId: supplierId || undefined,
      customerOrderId: customerOrderId || undefined,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить заказы поставщикам';
  }

  // Грузим поставщиков для селекта фильтра. Ошибка чтения не валит
  // страницу — просто скрываем селект.
  let suppliers: SupplierListItemDto[] = [];
  try {
    suppliers = await listSuppliers();
  } catch {
    suppliers = [];
  }

  const { pageItems, page, pageSize, total } = paginate(items, searchParams);

  return (
    <AdminPageShell
      icon={<ShoppingCart size={22} strokeWidth={1.6} aria-hidden />}
      title="Заказы поставщикам"
      subtitle={`Всего: ${items.length}`}
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader title="Фильтр" />

        <form
          action="/admin/purchase-orders"
          method="get"
          className="admin-form-grid"
          style={{ marginTop: 4 }}
        >
          <div className="admin-field">
            <label htmlFor="poSearch">Поиск</label>
            <input
              id="poSearch"
              name="search"
              type="search"
              defaultValue={search ?? ''}
              placeholder="номер, поставщик, комментарий, заказ"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="poStatus">Статус</label>
            <select id="poStatus" name="status" defaultValue={status ?? ''}>
              <option value="">Все статусы</option>
              {PURCHASE_ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PURCHASE_ORDER_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          {suppliers.length > 0 && (
            <div className="admin-field">
              <label htmlFor="poSupplier">Поставщик</label>
              <select
                id="poSupplier"
                name="supplierId"
                defaultValue={supplierId ?? ''}
              >
                <option value="">Все поставщики</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.status !== 'ACTIVE'
                      ? ` (${SUPPLIER_STATUS_LABELS[s.status as SupplierStatus] ?? s.status})`
                      : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="admin-field">
            <label htmlFor="poCustomerOrder">ID заказа покупателя</label>
            <input
              id="poCustomerOrder"
              name="customerOrderId"
              type="text"
              defaultValue={customerOrderId ?? ''}
              placeholder="cuid заказа (опционально)"
            />
          </div>
          <div className="admin-actions-row" style={{ alignItems: 'end' }}>
            <button type="submit" className="admin-btn">
              Применить
            </button>
            {(search || status || supplierId || customerOrderId) && (
              <Link
                href="/admin/purchase-orders"
                className="admin-btn admin-btn--ghost"
              >
                Сбросить
              </Link>
            )}
          </div>
        </form>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader
          title="Заказы поставщикам"
          hint={`Показано: ${pageItems.length}`}
        />
        <PurchaseOrdersTable rows={pageItems} />
        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/purchase-orders"
          preserveParams={{
            search: search || undefined,
            status: status || undefined,
            supplierId: supplierId || undefined,
            customerOrderId: customerOrderId || undefined,
          }}
          label="заказов"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

function PurchaseOrdersTable({ rows }: { rows: PurchaseOrderListItemDto[] }) {
  const columns: AdminTableColumn<PurchaseOrderListItemDto>[] = [
    {
      key: 'number',
      header: 'Номер',
      render: (po) => (
        <Link
          href={`/admin/purchase-orders/${po.id}`}
          className="admin-table__action-link"
        >
          <strong>{po.number}</strong>
        </Link>
      ),
    },
    {
      key: 'supplier',
      header: 'Поставщик',
      render: (po) =>
        po.supplierId ? (
          <Link
            href={`/admin/suppliers/${po.supplierId}`}
            className="admin-table__action-link"
          >
            {po.supplierNameSnapshot}
          </Link>
        ) : (
          <span>{po.supplierNameSnapshot}</span>
        ),
    },
    {
      key: 'customerOrder',
      header: 'Заказ покупателя',
      render: (po) =>
        po.customerOrderId && po.customerOrderNumber ? (
          <Link
            href={`/admin/orders/${po.customerOrderId}`}
            className="admin-table__action-link"
          >
            {po.customerOrderNumber}
          </Link>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (po) => (
        <AdminStatusBadge tone={statusTone(po.status)}>
          {formatStatus(po.status)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'eta',
      header: 'Ожидается',
      render: (po) => formatDate(po.expectedDeliveryDate),
    },
    {
      key: 'lines',
      header: 'Строк',
      align: 'right',
      render: (po) => po.linesCount,
    },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'right',
      render: (po) =>
        po.totalAmount ? (
          <strong>{po.totalAmount}</strong>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'created',
      header: 'Создан',
      render: (po) => (
        <span className="admin-muted" style={{ fontSize: '0.82rem' }}>
          {formatDateTime(po.createdAt)}
        </span>
      ),
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (po) => (
        <Link
          href={`/admin/purchase-orders/${po.id}`}
          className="admin-table__action-link"
        >
          Открыть
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      ),
    },
  ];
  return (
    <AdminTable
      rows={rows}
      columns={columns}
      rowKey={(po) => po.id}
      emptyContent={
        <AdminEmptyState
          icon={<ShoppingCart size={26} strokeWidth={1.6} aria-hidden />}
          title="Заказов поставщикам пока нет"
          hint="Создание идёт из карточки потребности цеха кнопкой «Создать заказ поставщику»."
        />
      }
    />
  );
}
