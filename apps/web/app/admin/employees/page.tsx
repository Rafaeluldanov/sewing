import Link from 'next/link';
import { ArrowRight, Plus, Users } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listEmployees } from '@/lib/employees-api';
import type { EmployeeListItemDto } from '@sewing/shared/employees';
import { EmployeeRowActions } from './row-actions';
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
import {
  formatCompensation,
  formatRole,
  formatStatus,
  statusTone,
} from '@/lib/admin-labels';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  pageSize?: string;
  tab?: string;
}

function formatMoney(value: number | null): React.ReactNode {
  if (value === null || value === 0) {
    return <span className="admin-muted">—</span>;
  }
  return (
    <strong>
      {value.toLocaleString('ru-RU', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      })}
      {' ₽'}
    </strong>
  );
}

/**
 * Список сотрудников (Admin UI 2.5).
 *
 * Backend / DTO не меняем — `GET /api/employees` отдаёт всех. Активные
 * и архивные показываем в отдельных табах (URL `?tab=archived`),
 * пагинация считается на клиенте через `paginate()`.
 */
export default async function AdminEmployeesListPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  let items: EmployeeListItemDto[] = [];
  let error: string | null = null;
  try {
    items = await listEmployees();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список сотрудников';
  }

  // Текущий пользователь нужен на каждый ряд: чтобы скрыть «Архивировать» /
  // «Удалить» на собственной карточке и спрятать hard-delete у не-ADMIN'а.
  const viewer = await getCurrentUserOrNull();

  const tab = searchParams?.tab === 'archived' ? 'archived' : 'active';
  const active = items.filter((e) => e.active);
  const archived = items.filter((e) => !e.active);
  const visible = tab === 'archived' ? archived : active;

  const { pageItems, page, pageSize, total } = paginate(visible, searchParams);

  return (
    <AdminPageShell
      icon={<Users size={22} strokeWidth={1.6} aria-hidden />}
      title="Сотрудники"
      subtitle={`Активных: ${active.length} · Архив: ${archived.length}`}
      actions={
        <Link
          href="/admin/employees/new"
          className="admin-btn admin-btn--primary"
        >
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          Добавить
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
            href="/admin/employees"
            className={`admin-tab ${tab === 'active' ? 'admin-tab--active' : ''}`}
          >
            Активные
          </Link>
          <Link
            href="/admin/employees?tab=archived"
            className={`admin-tab ${tab === 'archived' ? 'admin-tab--active' : ''}`}
          >
            Архив
          </Link>
        </div>

        <EmployeesTable
          items={pageItems}
          muted={tab === 'archived'}
          viewerId={viewer?.user.id ?? null}
          viewerRole={viewer?.user.role ?? ''}
        />

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/employees"
          preserveParams={{ tab: tab === 'archived' ? 'archived' : undefined }}
          label="сотрудников"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

function EmployeesTable({
  items,
  muted = false,
  viewerId,
  viewerRole,
}: {
  items: EmployeeListItemDto[];
  muted?: boolean;
  viewerId: string | null;
  viewerRole: string;
}) {
  const columns: AdminTableColumn<EmployeeListItemDto>[] = [
    {
      key: 'name',
      header: 'ФИО',
      render: (e) => <span className="admin-table__primary">{e.fullName}</span>,
    },
    {
      key: 'role',
      header: 'Роли',
      // Фича «несколько ролей»: показываем весь набор; основная — первой
      // и помечена жирным. Fallback на одиночную роль для старых DTO.
      render: (e) => {
        const roles = e.roles && e.roles.length > 0 ? e.roles : [e.role];
        const ordered = [e.role, ...roles.filter((r) => r !== e.role)];
        return (
          <span>
            {ordered.map((r, i) => (
              <span key={r}>
                {i > 0 ? ', ' : ''}
                <span
                  style={r === e.role ? { fontWeight: 600 } : undefined}
                  title={r === e.role ? 'Основная роль' : undefined}
                >
                  {formatRole(r)}
                </span>
              </span>
            ))}
          </span>
        );
      },
    },
    {
      key: 'compensation',
      header: 'Тип оплаты',
      render: (e) => formatCompensation(e.compensationType),
    },
    {
      key: 'rate',
      header: 'Ставка, ₽/час',
      align: 'right',
      render: (e) => formatMoney(e.salaryPerHour),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (e) => (
        <AdminStatusBadge tone={statusTone(e.active)}>
          {formatStatus(e.active)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      isAction: true,
      render: (e) => (
        <div className="employee-row-actions">
          <Link
            href={`/admin/employees/${e.id}`}
            className="admin-table__action-link"
          >
            Открыть
            <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
          </Link>
          <EmployeeRowActions
            employee={e}
            viewerId={viewerId}
            viewerRole={viewerRole}
          />
        </div>
      ),
    },
  ];
  return (
    <div style={muted ? { opacity: 0.7 } : undefined}>
      <AdminTable
        rows={items}
        columns={columns}
        rowKey={(e) => e.id}
        emptyContent={
          <AdminEmptyState
            icon={<Users size={26} strokeWidth={1.6} aria-hidden />}
            title="Здесь пока пусто"
          />
        }
      />
    </div>
  );
}
