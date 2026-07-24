/**
 * Список поставщиков (`/admin/suppliers`, Этап 5).
 *
 * Backend: `GET /api/suppliers?search=&status=` — отдаёт сразу с
 * счётчиками (`contactsCount`, `catalogItemsCount`). Раскладываем по
 * двум табам «Активные» / «В архиве» через локальный фильтр после
 * единого fetch-а — на MVP-объёмах это безопасно и убирает
 * round-trip-ы.
 *
 * Доступ — `ADMIN` / `SHOP_MANAGER` (на backend). Sidebar показывает
 * пункт только при `NEXT_PUBLIC_FEATURE_SUPPLIERS=1` (см.
 * `admin-sidebar.tsx`).
 */
import Link from 'next/link';
import {
  ArrowRight,
  ContactRound,
  Globe,
  PackageSearch,
  Plus,
  Truck,
} from 'lucide-react';
import {
  SUPPLIER_STATUS_LABELS,
  type SupplierListItemDto,
  type SupplierStatus,
} from '@sewing/shared/suppliers';
import { ApiRequestError, errorText } from '@/lib/api';
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
  tab?: string;
}

function statusTone(status: string): AdminStatusTone {
  switch (status as SupplierStatus) {
    case 'ACTIVE':
      return 'success';
    case 'INACTIVE':
      return 'muted';
    default:
      return 'muted';
  }
}

function formatStatus(status: string): string {
  return SUPPLIER_STATUS_LABELS[status as SupplierStatus] ?? status;
}

export default async function AdminSuppliersListPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const search = searchParams?.search?.trim();
  const tab = searchParams?.tab === 'archived' ? 'archived' : 'active';

  let items: SupplierListItemDto[] = [];
  let error: string | null = null;
  try {
    items = await listSuppliers({ search: search || undefined });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список поставщиков';
  }

  const active = items.filter((s) => s.status === 'ACTIVE');
  const archived = items.filter((s) => s.status !== 'ACTIVE');
  const visible = tab === 'archived' ? archived : active;

  const { pageItems, page, pageSize, total } = paginate(visible, searchParams);

  return (
    <AdminPageShell
      icon={<Truck size={22} strokeWidth={1.6} aria-hidden />}
      title="Поставщики"
      subtitle={`Активных: ${active.length} · Архив: ${archived.length}`}
      actions={
        <Link
          href="/admin/suppliers/new"
          className="admin-btn admin-btn--primary"
        >
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          Добавить поставщика
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader
          title={tab === 'archived' ? 'Архив' : 'Активные'}
          hint={`${visible.length}`}
        />

        <div className="admin-tabs" style={{ marginTop: -8 }}>
          <Link
            href={
              search
                ? `/admin/suppliers?search=${encodeURIComponent(search)}`
                : '/admin/suppliers'
            }
            className={`admin-tab ${tab === 'active' ? 'admin-tab--active' : ''}`}
          >
            Активные
          </Link>
          <Link
            href={
              search
                ? `/admin/suppliers?tab=archived&search=${encodeURIComponent(search)}`
                : '/admin/suppliers?tab=archived'
            }
            className={`admin-tab ${tab === 'archived' ? 'admin-tab--active' : ''}`}
          >
            Архив
          </Link>
        </div>

        <form
          action="/admin/suppliers"
          method="get"
          className="admin-form-grid"
          style={{ marginTop: 12 }}
        >
          {tab === 'archived' && (
            <input type="hidden" name="tab" value="archived" />
          )}
          <div className="admin-field">
            <label htmlFor="supplierSearch">Поиск</label>
            <input
              id="supplierSearch"
              name="search"
              type="search"
              defaultValue={search ?? ''}
              placeholder="название, телефон, сайт"
            />
          </div>
          <div className="admin-actions-row" style={{ alignItems: 'end' }}>
            <button type="submit" className="admin-btn">
              Найти
            </button>
            {search && (
              <Link
                href={
                  tab === 'archived'
                    ? '/admin/suppliers?tab=archived'
                    : '/admin/suppliers'
                }
                className="admin-btn admin-btn--ghost"
              >
                Сбросить
              </Link>
            )}
          </div>
        </form>

        <SuppliersTable items={pageItems} muted={tab === 'archived'} />

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/suppliers"
          preserveParams={{
            tab: tab === 'archived' ? 'archived' : undefined,
            search: search || undefined,
          }}
          label="поставщиков"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

function SuppliersTable({
  items,
  muted = false,
}: {
  items: SupplierListItemDto[];
  muted?: boolean;
}) {
  const columns: AdminTableColumn<SupplierListItemDto>[] = [
    {
      key: 'name',
      header: 'Название',
      render: (s) => <span className="admin-table__primary">{s.name}</span>,
    },
    {
      key: 'phone',
      header: 'Телефон',
      render: (s) => s.phone ?? <span className="admin-muted">—</span>,
    },
    {
      key: 'website',
      header: 'Сайт',
      render: (s) =>
        s.website ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Globe size={12} strokeWidth={1.6} aria-hidden />
            {s.website}
          </span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'contacts',
      header: 'Контакты',
      align: 'right',
      render: (s) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ContactRound size={12} strokeWidth={1.6} aria-hidden />
          {s.contactsCount}
        </span>
      ),
    },
    {
      key: 'catalog',
      header: 'Номенклатура',
      align: 'right',
      render: (s) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <PackageSearch size={12} strokeWidth={1.6} aria-hidden />
          {s.catalogItemsCount}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (s) => (
        <AdminStatusBadge tone={statusTone(s.status)}>
          {formatStatus(s.status)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (s) => (
        <Link
          href={`/admin/suppliers/${s.id}`}
          className="admin-table__action-link"
        >
          Открыть
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      ),
    },
  ];
  return (
    <div style={muted ? { opacity: 0.7 } : undefined}>
      <AdminTable
        rows={items}
        columns={columns}
        rowKey={(s) => s.id}
        rowHref={(s) => `/admin/suppliers/${s.id}`}
        emptyContent={
          <AdminEmptyState
            icon={<Truck size={26} strokeWidth={1.6} aria-hidden />}
            title="Здесь пока пусто"
            hint="Нажмите «Добавить поставщика», чтобы завести первую карточку."
          />
        }
      />
    </div>
  );
}

