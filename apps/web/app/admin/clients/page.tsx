import Link from 'next/link';
import { ArrowRight, Building2, Plus } from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import { ApiRequestError, errorText } from '@/lib/api';
import { listClients } from '@/lib/clients-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminSearchInput,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  paginate,
  type AdminTableColumn,
} from '@/components/admin';
import { formatStatus, statusTone } from '@/lib/admin-labels';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  pageSize?: string;
  search?: string;
  tab?: string;
}

/**
 * Список клиентов (Admin UI, новый блок).
 *
 * Backend `GET /api/clients` по умолчанию возвращает только активных;
 * для архива явно передаём `includeInactive=true` и фильтруем на
 * клиенте — это позволяет одной таблицей закрыть оба таба без
 * лишних round-trip-ов. Поиск работает по `name` (case-insensitive
 * `contains`, см. `ClientsService.list`).
 */
export default async function AdminClientsListPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const search = searchParams?.search?.trim();
  const tab = searchParams?.tab === 'archived' ? 'archived' : 'active';

  let items: ClientDto[] = [];
  let error: string | null = null;
  try {
    items = await listClients({
      includeInactive: true,
      search: search || undefined,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список клиентов';
  }

  const active = items.filter((c) => c.isActive);
  const archived = items.filter((c) => !c.isActive);
  const visible = tab === 'archived' ? archived : active;

  const { pageItems, page, pageSize, total } = paginate(visible, searchParams);

  return (
    <AdminPageShell
      icon={<Building2 size={22} strokeWidth={1.6} aria-hidden />}
      title="Клиенты"
      subtitle={`Активных: ${active.length} · Архив: ${archived.length}`}
      actions={
        <Link href="/admin/clients/new" className="admin-btn admin-btn--primary">
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          Добавить клиента
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
            href={search ? `/admin/clients?search=${encodeURIComponent(search)}` : '/admin/clients'}
            className={`admin-tab ${tab === 'active' ? 'admin-tab--active' : ''}`}
          >
            Активные
          </Link>
          <Link
            href={
              search
                ? `/admin/clients?tab=archived&search=${encodeURIComponent(search)}`
                : '/admin/clients?tab=archived'
            }
            className={`admin-tab ${tab === 'archived' ? 'admin-tab--active' : ''}`}
          >
            Архив
          </Link>
        </div>

        <form action="/admin/clients" method="get" className="admin-form-grid" style={{ marginTop: 12 }}>
          {tab === 'archived' && <input type="hidden" name="tab" value="archived" />}
          <AdminSearchInput
            id="clientSearch"
            label="Поиск по названию"
            placeholder="Например: ИП Петров"
            initial={search ?? ''}
            basePath="/admin/clients"
            preserveParams={{
              tab: tab === 'archived' ? 'archived' : undefined,
            }}
          />
          <div className="admin-actions-row" style={{ alignItems: 'end' }}>
            <button type="submit" className="admin-btn">
              Найти
            </button>
            {search && (
              <Link
                href={tab === 'archived' ? '/admin/clients?tab=archived' : '/admin/clients'}
                className="admin-btn admin-btn--ghost"
              >
                Сбросить
              </Link>
            )}
          </div>
        </form>

        <ClientsTable items={pageItems} muted={tab === 'archived'} />

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/clients"
          preserveParams={{
            tab: tab === 'archived' ? 'archived' : undefined,
            search: search || undefined,
          }}
          label="клиентов"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

function ClientsTable({
  items,
  muted = false,
}: {
  items: ClientDto[];
  muted?: boolean;
}) {
  const columns: AdminTableColumn<ClientDto>[] = [
    {
      key: 'name',
      header: 'Название',
      render: (c) => <span className="admin-table__primary">{c.name}</span>,
    },
    {
      key: 'phone',
      header: 'Телефон',
      render: (c) => c.phone ?? <span className="admin-muted">—</span>,
    },
    {
      key: 'email',
      header: 'Email',
      render: (c) => c.email ?? <span className="admin-muted">—</span>,
    },
    {
      key: 'status',
      header: 'Статус',
      render: (c) => (
        <AdminStatusBadge tone={statusTone(c.isActive)}>
          {formatStatus(c.isActive)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (c) => (
        <Link href={`/admin/clients/${c.id}`} className="admin-table__action-link">
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
        rowKey={(c) => c.id}
        rowHref={(c) => `/admin/clients/${c.id}`}
        emptyContent={
          <AdminEmptyState
            icon={<Building2 size={26} strokeWidth={1.6} aria-hidden />}
            title="Здесь пока пусто"
          />
        }
      />
    </div>
  );
}
