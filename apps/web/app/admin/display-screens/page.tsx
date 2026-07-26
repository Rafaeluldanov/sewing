import Link from 'next/link';
import { ArrowRight, MonitorSmartphone, Plus } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { listDisplayScreens } from '@/lib/display-screens-api';
import type { DisplayScreenListItemDto } from '@sewing/shared/display-screens';
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
  archiveDisplayScreensAction,
  purgeDisplayScreensAction,
  restoreDisplayScreensAction,
} from './archive-actions';

export const dynamic = 'force-dynamic';

/**
 * Список display-экранов (Admin UI 2.5).
 *
 * Каждый экран — это пара «DISPLAY-учётка + подразделение».
 *
 * Этап «Архив справочников»: вместо двух карточек «Активные» /
 * «Отключённые» — вкладки, как в остальных справочниках, плюс
 * массовые «В архив» / «Вернуть» / «Удалить навсегда». Архивация
 * гасит и учётку монитора (backend), удаление навсегда — только из
 * архива и вместе с учёткой (иначе её логин остаётся занятым).
 */
export default async function AdminDisplayScreensListPage({
  searchParams,
}: {
  searchParams?: { tab?: string };
}) {
  const tab: 'active' | 'archive' =
    searchParams?.tab === 'archive' ? 'archive' : 'active';

  let items: DisplayScreenListItemDto[] = [];
  let error: string | null = null;
  try {
    items = await listDisplayScreens();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список display-экранов';
  }

  const active = items.filter((s) => s.isActive);
  const archived = items.filter((s) => !s.isActive);
  const visible = tab === 'archive' ? archived : active;

  return (
    <AdminPageShell
      icon={<MonitorSmartphone size={22} strokeWidth={1.6} aria-hidden />}
      title="Display-экраны"
      subtitle={`Активных: ${active.length} · Архив: ${archived.length}`}
      actions={
        <Link
          href="/admin/display-screens/new"
          className="admin-btn admin-btn--primary"
        >
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          Создать экран
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
          basePath="/admin/display-screens"
          tab={tab}
          activeCount={active.length}
          archiveCount={archived.length}
        />

        <BulkArchiveProvider
          mode={tab}
          allIds={visible.map((s) => s.id)}
          actions={{
            archive: archiveDisplayScreensAction,
            restore: restoreDisplayScreensAction,
            purge: purgeDisplayScreensAction,
          }}
          labels={{
            one: 'экран',
            many: 'экранов',
            archiveHint:
              'Экраны перестанут показываться в цехе, а их учётки монитора — логиниться.',
            purgeHint:
              'Вместе с экраном удалится его DISPLAY-учётка (логин освободится).',
          }}
        >
          <AdminSectionHeader
            title={tab === 'archive' ? 'Архив' : 'Активные'}
            hint={
              tab === 'archive'
                ? `В архиве: ${archived.length}. Удаление навсегда — только отсюда.`
                : `${active.length}`
            }
            actions={<BulkArchiveHeaderButton />}
          />
          <DisplayScreensTable items={visible} muted={tab === 'archive'} />
        </BulkArchiveProvider>
      </AdminCard>
    </AdminPageShell>
  );
}

/**
 * Куда «проваливается» строка экрана. Отдельной карточки экрана в
 * админке нет, поэтому drill-in = открыть то, что этот экран
 * показывает в зале: `/shopfloor/display` в области его подразделения
 * (`?divisionCode=<CompanyDivision.code>`, см.
 * `app/shopfloor/display/page.tsx`). Экран без подразделения ведёт на
 * общий агрегат по всем активным заказам.
 */
function screenBoardHref(s: DisplayScreenListItemDto): string {
  return s.companyDivision
    ? `/shopfloor/display?divisionCode=${encodeURIComponent(
        s.companyDivision.code,
      )}`
    : '/shopfloor/display';
}

function DisplayScreensTable({
  items,
  muted = false,
}: {
  items: DisplayScreenListItemDto[];
  muted?: boolean;
}) {
  const columns: AdminTableColumn<DisplayScreenListItemDto>[] = [
    {
      key: 'select',
      header: <BulkArchiveSelectAll ids={items.map((s) => s.id)} />,
      sortable: false,
      render: (s) => <BulkArchiveCheckbox id={s.id} />,
    },
    {
      key: 'name',
      header: 'Название',
      render: (s) => <span className="admin-table__primary">{s.name}</span>,
    },
    {
      key: 'companyDivision',
      header: 'Подразделение',
      render: (s) => s.companyDivision?.name ?? '— не указано —',
    },
    {
      key: 'login',
      header: 'Логин',
      render: (s) => (
        <code style={{ fontSize: '0.85rem' }}>{s.employeeLogin}</code>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (s) => (
        <AdminStatusBadge tone={s.isActive ? 'success' : 'muted'}>
          {s.isActive ? 'активен' : 'в архиве'}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'archive',
      header: '',
      isAction: true,
      render: (s) => <BulkArchiveRowActions id={s.id} />,
    },
    {
      // Явная ссылка-афформанс к drill-in по строке (`rowHref` ниже):
      // без неё «провалиться» можно было бы только слепым кликом, без
      // клавиатуры и без открытия в новой вкладке.
      key: 'open',
      header: '',
      isAction: true,
      render: (s) => (
        <Link href={screenBoardHref(s)} className="admin-table__action-link">
          Монитор
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
        /*
          Drill-in: карточки экрана в админке нет, поэтому «провалиться»
          в строку = открыть то, что этот экран показывает в зале —
          `/shopfloor/display` в области его подразделения
          (`?divisionCode=<CompanyDivision.code>`, см.
          `app/shopfloor/display/page.tsx`). Экран без подразделения
          ведёт на общий агрегат по всем активным заказам.
        */
        rowHref={screenBoardHref}
        emptyContent={
          <AdminEmptyState
            icon={
              <MonitorSmartphone size={26} strokeWidth={1.6} aria-hidden />
            }
            title="Пусто"
          />
        }
      />
    </div>
  );
}
