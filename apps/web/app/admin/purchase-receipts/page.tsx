/**
 * Список документов приёмки (`/admin/purchase-receipts`).
 *
 * Этап 7А «Приёмка поставок» (см. `docs/recon-soft-integration.md
 * §«Этап 7А»`). Документ фактической приёмки по конкретному
 * `PurchaseOrder`: фиксирует количество, ячейку, параметры партии.
 *
 * Backend: `GET /api/purchase-receipts` (см.
 * `apps/api/src/modules/purchase-receipts/*`).
 *
 * RBAC и feature-flag: страница доступна только под
 * `ADMIN`/`SHOP_MANAGER` (sidebar показывает пункт только при
 * `NEXT_PUBLIC_FEATURE_PURCHASE_RECEIPTS=1`).
 */
import Link from 'next/link';
import { ArrowRight, ClipboardCheck } from 'lucide-react';
import {
  PURCHASE_RECEIPT_STATUSES,
  PURCHASE_RECEIPT_STATUS_LABELS,
  type PurchaseReceiptListItemDto,
  type PurchaseReceiptStatus,
} from '@sewing/shared/purchase-receipts';
import {
  SUPPLIER_STATUS_LABELS,
  type SupplierListItemDto,
  type SupplierStatus,
} from '@sewing/shared/suppliers';
import { ApiRequestError } from '@/lib/api';
import { listPurchaseReceipts } from '@/lib/purchase-receipts-api';
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
  purchaseOrderId?: string;
  customerOrderId?: string;
  cellId?: string;
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

export default async function AdminPurchaseReceiptsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const search = searchParams?.search?.trim();
  const supplierId = searchParams?.supplierId?.trim();
  const purchaseOrderId = searchParams?.purchaseOrderId?.trim();
  const customerOrderId = searchParams?.customerOrderId?.trim();
  const cellId = searchParams?.cellId?.trim();
  const statusRaw = searchParams?.status?.trim();
  const status =
    statusRaw &&
    (PURCHASE_RECEIPT_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as PurchaseReceiptStatus)
      : undefined;

  let items: PurchaseReceiptListItemDto[] = [];
  let error: string | null = null;
  try {
    items = await listPurchaseReceipts({
      search: search || undefined,
      status,
      supplierId: supplierId || undefined,
      purchaseOrderId: purchaseOrderId || undefined,
      customerOrderId: customerOrderId || undefined,
      cellId: cellId || undefined,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить документы приёмки';
  }

  // Грузим поставщиков для селекта фильтра. Ошибка чтения не валит
  // страницу, но показываем предупреждение — иначе фильтр по
  // поставщику молча исчезает.
  let suppliers: SupplierListItemDto[] = [];
  let suppliersWarning: string | null = null;
  try {
    suppliers = await listSuppliers();
  } catch {
    suppliersWarning =
      'Не удалось загрузить список поставщиков — фильтр по поставщику недоступен.';
    suppliers = [];
  }

  const { pageItems, page, pageSize, total } = paginate(items, searchParams);

  return (
    <AdminPageShell
      icon={<ClipboardCheck size={22} strokeWidth={1.6} aria-hidden />}
      title="Приёмка поставок"
      subtitle={`Всего: ${items.length}`}
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {suppliersWarning && (
        <div className="error-box" role="alert">
          {suppliersWarning}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader title="Фильтр" />

        <form
          action="/admin/purchase-receipts"
          method="get"
          className="admin-form-grid"
          style={{ marginTop: 4 }}
        >
          <div className="admin-field">
            <label htmlFor="prSearch">Поиск</label>
            <input
              id="prSearch"
              name="search"
              type="search"
              defaultValue={search ?? ''}
              placeholder="номер, поставщик, комментарий, заказ"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="prStatus">Статус</label>
            <select id="prStatus" name="status" defaultValue={status ?? ''}>
              <option value="">Все статусы</option>
              {PURCHASE_RECEIPT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PURCHASE_RECEIPT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          {suppliers.length > 0 && (
            <div className="admin-field">
              <label htmlFor="prSupplier">Поставщик</label>
              <select
                id="prSupplier"
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
            <label htmlFor="prPo">ID заказа поставщику</label>
            <input
              id="prPo"
              name="purchaseOrderId"
              type="text"
              defaultValue={purchaseOrderId ?? ''}
              placeholder="cuid PO (опционально)"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="prCustomerOrder">ID заказа покупателя</label>
            <input
              id="prCustomerOrder"
              name="customerOrderId"
              type="text"
              defaultValue={customerOrderId ?? ''}
              placeholder="cuid заказа (опционально)"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="prCell">ID ячейки</label>
            <input
              id="prCell"
              name="cellId"
              type="text"
              defaultValue={cellId ?? ''}
              placeholder="cuid ячейки (опционально)"
            />
          </div>
          <div className="admin-actions-row" style={{ alignItems: 'end' }}>
            <button type="submit" className="admin-btn">
              Применить
            </button>
            {(search ||
              status ||
              supplierId ||
              purchaseOrderId ||
              customerOrderId ||
              cellId) && (
              <Link
                href="/admin/purchase-receipts"
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
          title="Документы приёмки"
          hint={`Показано: ${pageItems.length}`}
        />
        <PurchaseReceiptsTable rows={pageItems} />
        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/purchase-receipts"
          preserveParams={{
            search: search || undefined,
            status: status || undefined,
            supplierId: supplierId || undefined,
            purchaseOrderId: purchaseOrderId || undefined,
            customerOrderId: customerOrderId || undefined,
            cellId: cellId || undefined,
          }}
          label="документов"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

function PurchaseReceiptsTable({
  rows,
}: {
  rows: PurchaseReceiptListItemDto[];
}) {
  const columns: AdminTableColumn<PurchaseReceiptListItemDto>[] = [
    {
      key: 'number',
      header: 'Номер',
      render: (pr) => (
        <Link
          href={`/admin/purchase-receipts/${pr.id}`}
          className="admin-table__action-link"
        >
          <strong>{pr.number}</strong>
        </Link>
      ),
    },
    {
      key: 'po',
      header: 'Заказ поставщику',
      render: (pr) => (
        <Link
          href={`/admin/purchase-orders/${pr.purchaseOrderId}`}
          className="admin-table__action-link"
        >
          {pr.purchaseOrderNumber}
        </Link>
      ),
    },
    {
      key: 'supplier',
      header: 'Поставщик',
      render: (pr) =>
        pr.supplierId ? (
          <Link
            href={`/admin/suppliers/${pr.supplierId}`}
            className="admin-table__action-link"
          >
            {pr.supplierNameSnapshot ?? '—'}
          </Link>
        ) : (
          <span>{pr.supplierNameSnapshot ?? '—'}</span>
        ),
    },
    {
      key: 'customerOrder',
      header: 'Заказ покупателя',
      render: (pr) =>
        pr.customerOrderId && pr.customerOrderNumber ? (
          <Link
            href={`/admin/orders/${pr.customerOrderId}`}
            className="admin-table__action-link"
          >
            {pr.customerOrderNumber}
          </Link>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'receivedAt',
      header: 'Принято',
      render: (pr) => formatDateTime(pr.receivedAt),
    },
    {
      key: 'receivedBy',
      header: 'Кто принял',
      render: (pr) =>
        pr.receivedByName ?? <span className="admin-muted">—</span>,
    },
    {
      key: 'status',
      header: 'Статус',
      render: (pr) => (
        <AdminStatusBadge tone={statusTone(pr.status)}>
          {formatStatus(pr.status)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'lines',
      header: 'Строк',
      align: 'right',
      render: (pr) => pr.linesCount,
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (pr) => (
        <Link
          href={`/admin/purchase-receipts/${pr.id}`}
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
      rowKey={(pr) => pr.id}
      emptyContent={
        <AdminEmptyState
          icon={<ClipboardCheck size={26} strokeWidth={1.6} aria-hidden />}
          title="Приёмок пока нет"
          hint="Оформление идёт из карточки заказа поставщику кнопкой «Принять поступление»."
        />
      }
    />
  );
}
