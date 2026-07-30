import Link from 'next/link';
import { ArrowRight, Lock, Plus, ShieldCheck } from 'lucide-react';
import type { AppRoleDto } from '@sewing/shared/app-roles';
import { ROLE_WORKSPACE_LABELS, type RoleWorkspace } from '@sewing/shared/app-roles';
import { ApiRequestError, errorText } from '@/lib/api';
import { listAppRoles } from '@/lib/app-roles-api';
import {
  AdminArchiveTabs,
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  BulkArchiveCheckbox,
  BulkArchiveHeaderButton,
  BulkArchiveProvider,
  BulkArchiveSelectAll,
  BulkArchiveRowActions,
  type AdminTableColumn,
} from '@/components/admin';
import {
  archiveAppRolesAction,
  purgeAppRolesAction,
  restoreAppRolesAction,
} from './archive-actions';

export const dynamic = 'force-dynamic';

/**
 * Справочник ролей (`/admin/roles`).
 *
 * Роль перестала быть значением enum-а в схеме: новую («Технолог»,
 * «Кладовщик») заводят здесь, без правки кода и деплоя. Права роль
 * получает НАСЛЕДОВАНИЕМ — отмечает роли-доноры, чьи разрешения
 * забирает целиком (см. `RoleForm` и `AppRolesService.expand`).
 *
 * 12 системных ролей показываются в том же списке с замком: их коды
 * зашиты в бэкенде и терминалах цеха, поэтому у них правится только
 * название, а архивация и удаление запрещены.
 */
export default async function AdminRolesListPage({
  searchParams,
}: {
  searchParams?: { tab?: string };
}) {
  const tab: 'active' | 'archive' =
    searchParams?.tab === 'archive' ? 'archive' : 'active';

  let items: AppRoleDto[] = [];
  let error: string | null = null;
  try {
    items = await listAppRoles();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить справочник ролей';
  }

  const active = items.filter((r) => r.active);
  const archived = items.filter((r) => !r.active);
  const visible = tab === 'archive' ? archived : active;
  const custom = active.filter((r) => !r.system).length;

  // Название роли по коду — для колонки «Наследует»: в `inherits`
  // лежат коды, а показывать пользователю надо человеческие имена.
  const nameByCode = new Map(items.map((r) => [r.code, r.name]));

  return (
    <AdminPageShell
      icon={<ShieldCheck size={22} strokeWidth={1.6} aria-hidden />}
      title="Роли"
      subtitle={`Системных: ${active.length - custom} · Своих: ${custom} · Архив: ${archived.length}`}
      actions={
        <Link href="/admin/roles/new" className="admin-btn admin-btn--primary">
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          Новая роль
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminArchiveTabs
          basePath="/admin/roles"
          tab={tab}
          activeCount={active.length}
          archiveCount={archived.length}
        />

        <BulkArchiveProvider
          mode={tab}
          allIds={visible.map((r) => r.id)}
          actions={{
            archive: archiveAppRolesAction,
            restore: restoreAppRolesAction,
            purge: purgeAppRolesAction,
          }}
          labels={{
            one: 'роль',
            many: 'ролей',
            archiveHint:
              'Роль перестанет предлагаться при назначении. У сотрудников, которым она уже выдана, доступ сохранится.',
            purgeHint:
              'Удалить навсегда можно только роль, которую никому не выдали и никто не наследует.',
          }}
        >
          <AdminSectionHeader
            title={tab === 'archive' ? 'Архив' : 'Активные'}
            hint={
              tab === 'archive'
                ? `В архиве: ${archived.length}. Удаление навсегда — только отсюда.`
                : 'Системные роли (с замком) изменить или удалить нельзя — их коды зашиты в приложении.'
            }
            actions={<BulkArchiveHeaderButton />}
          />
          <RolesTable
            items={visible}
            nameByCode={nameByCode}
            muted={tab === 'archive'}
          />
        </BulkArchiveProvider>
      </AdminCard>
    </AdminPageShell>
  );
}

function RolesTable({
  items,
  nameByCode,
  muted = false,
}: {
  items: AppRoleDto[];
  nameByCode: Map<string, string>;
  muted?: boolean;
}) {
  const columns: AdminTableColumn<AppRoleDto>[] = [
    {
      key: 'select',
      header: <BulkArchiveSelectAll ids={items.map((r) => r.id)} />,
      sortable: false,
      render: (r) => <BulkArchiveCheckbox id={r.id} />,
    },
    {
      key: 'name',
      header: 'Роль',
      render: (r) => (
        <span className="admin-table__primary">
          {r.system && (
            <Lock
              size={13}
              strokeWidth={1.6}
              aria-label="системная роль"
              style={{ marginRight: 6, verticalAlign: -2, opacity: 0.6 }}
            />
          )}
          {r.name}
        </span>
      ),
    },
    {
      key: 'code',
      header: 'Код',
      render: (r) => <code style={{ fontSize: '0.85rem' }}>{r.code}</code>,
    },
    {
      key: 'inherits',
      header: 'Наследует',
      sortable: false,
      render: (r) =>
        r.inherits.length === 0
          ? '—'
          : r.inherits.map((c) => nameByCode.get(c) ?? c).join(', '),
    },
    {
      key: 'workspace',
      header: 'Рабочий экран',
      render: (r) =>
        ROLE_WORKSPACE_LABELS[r.workspace as RoleWorkspace] ?? r.workspace,
    },
    {
      key: 'employeeCount',
      header: 'Сотрудников',
      render: (r) => (r.employeeCount > 0 ? r.employeeCount : '—'),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (r) => (
        <AdminStatusBadge tone={r.active ? 'success' : 'muted'}>
          {r.active ? (r.system ? 'системная' : 'активна') : 'в архиве'}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'archive',
      header: '',
      isAction: true,
      // Системным ролям кнопок архива не показываем вовсе: backend их
      // всё равно отвергнет, а кнопка, которая обязана не сработать, —
      // это ложное обещание.
      render: (r) => (r.system ? null : <BulkArchiveRowActions id={r.id} />),
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (r) => (
        <Link
          href={`/admin/roles/${r.id}`}
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
        rowKey={(r) => r.id}
        rowHref={(r) => `/admin/roles/${r.id}`}
        emptyContent={
          <AdminEmptyState
            icon={<ShieldCheck size={26} strokeWidth={1.6} aria-hidden />}
            title="Пусто"
          />
        }
      />
    </div>
  );
}
