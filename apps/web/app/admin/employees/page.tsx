import Link from 'next/link';
import { ArrowRight, Clock3, Plus, Users } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listEmployees } from '@/lib/employees-api';
import { listAppRolesSafe } from '@/lib/app-roles-api';
import type { EmployeeListItemDto } from '@sewing/shared/employees';
import {
  archiveEmployeesAction,
  purgeEmployeesAction,
  restoreEmployeesAction,
} from './archive-actions';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  BulkArchiveCheckbox,
  BulkArchiveHeaderButton,
  BulkArchiveProvider,
  BulkArchiveSelectAll,
  BulkArchiveRowActions,
  paginate,
  type AdminTableColumn,
} from '@/components/admin';
import {
  formatCompensation,
  buildRoleLabels,
  formatRole,
  type RoleLabelMap,
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
  // Названия ролей — из справочника (`/admin/roles`): роли заводятся из
  // админки, и без словаря кастомная роль показалась бы кодом.
  const roleLabels = buildRoleLabels(await listAppRolesSafe());

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
        <>
          <Link
            href="/admin/employees/time-tracker"
            className="admin-btn admin-btn--ghost"
          >
            <Clock3 size={16} strokeWidth={1.6} aria-hidden />
            Тайм-трекер
          </Link>
          <Link
            href="/admin/employees/new"
            className="admin-btn admin-btn--primary"
          >
            <Plus size={16} strokeWidth={1.6} aria-hidden />
            Добавить
          </Link>
        </>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        {/* Вкладки этого раздела появились раньше общего
            `AdminArchiveTabs` и живут на `?tab=archived` — ссылки из
            писем/закладок не ломаем, поэтому оставляем как есть. */}
        <div className="admin-tabs" style={{ marginTop: -8 }}>
          <Link
            href="/admin/employees"
            className={`admin-tab ${tab === 'active' ? 'admin-tab--active' : ''}`}
          >
            Активные ({active.length})
          </Link>
          <Link
            href="/admin/employees?tab=archived"
            className={`admin-tab ${tab === 'archived' ? 'admin-tab--active' : ''}`}
          >
            Архив ({archived.length})
          </Link>
        </div>

        {/* Этап «Архив справочников»: массовые «В архив» / «Вернуть» /
            «Удалить навсегда». Гейты раздела (открытая смена, история,
            «нельзя на себе», последний админ) считает backend и
            возвращает причину по каждой пропущенной строке. */}
        <BulkArchiveProvider
          mode={tab === 'archived' ? 'archive' : 'active'}
          allIds={visible.map((e) => e.id)}
          actions={{
            archive: archiveEmployeesAction,
            restore: restoreEmployeesAction,
            purge: purgeEmployeesAction,
          }}
          labels={{
            one: 'сотрудника',
            many: 'сотрудников',
            archiveHint:
              'Учётки перестанут пускать в систему. История, смены и начисления сохранятся.',
            purgeHint:
              'Карточка пропадёт из БД (в аудите останется снимок). Сотрудники с историей будут пропущены.',
          }}
        >
          <AdminSectionHeader
            title={tab === 'archived' ? 'Архив' : 'Активные'}
            hint={
              tab === 'archived'
                ? `В архиве: ${visible.length}. Удаление навсегда — только отсюда.`
                : `${visible.length}`
            }
            actions={<BulkArchiveHeaderButton />}
          />

          <EmployeesTable
            items={pageItems}
            muted={tab === 'archived'}
            viewerId={viewer?.user.id ?? null}
            viewerRole={viewer?.user.role ?? ''}
            roleLabels={roleLabels}
          />
        </BulkArchiveProvider>

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
  roleLabels,
}: {
  items: EmployeeListItemDto[];
  muted?: boolean;
  viewerId: string | null;
  viewerRole: string;
  /** Словарь «код роли → название» из справочника `/admin/roles`. */
  roleLabels: RoleLabelMap;
}) {
  const columns: AdminTableColumn<EmployeeListItemDto>[] = [
    {
      key: 'select',
      header: <BulkArchiveSelectAll ids={items.map((e) => e.id)} />,
      sortable: false,
      render: (e) => <BulkArchiveCheckbox id={e.id} />,
    },
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
                  {formatRole(r, roleLabels)}
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
      // Одна колонка на две ставки (29.07.2026): у почасовика тут
      // ₽/час, у месячника — ₽/мес. Две отдельные колонки в списке
      // из 10+ столбцов означали бы, что в каждой строке одна из них
      // пустая, а взгляд всё равно ищет «сколько платим».
      key: 'rate',
      header: 'Ставка',
      align: 'right',
      render: (e) => {
        const monthly = (e.salaryRateMode ?? 'HOURLY') === 'MONTHLY';
        const value = monthly ? e.salaryPerMonth ?? null : e.salaryPerHour;
        if (value === null || value === 0) return formatMoney(null);
        return (
          <>
            {formatMoney(value)}
            <span className="admin-muted">{monthly ? ' /мес' : ' /час'}</span>
          </>
        );
      },
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
          {/* «В архив» (активные) / «Вернуть» + «Удалить» (архив) —
              общий компонент разделов; сам себя архивировать нельзя,
              поэтому строку viewer-а гасим сразу. */}
          <BulkArchiveRowActions
            id={e.id}
            disabled={viewerId === e.id}
            disabledHint="Нельзя выполнять это действие на своей учётке"
          />
          <Link
            href={`/admin/employees/${e.id}`}
            className="admin-table__action-link"
          >
            Открыть
            <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
          </Link>
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
        rowHref={(e) => `/admin/employees/${e.id}`}
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
