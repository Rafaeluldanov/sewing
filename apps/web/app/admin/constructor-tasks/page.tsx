import Link from 'next/link';
import { ArrowRight, ClipboardList } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { listConstructorTasks } from '@/lib/constructor-tasks-api';
import type { ConstructorTaskSummaryDto } from '@sewing/shared/constructor-tasks';
import {
  CONSTRUCTOR_TASK_STATUS_LABELS,
  CONSTRUCTOR_TASK_STATUS_TONE,
} from '@sewing/shared/constructor-tasks';
import {
  AdminArchiveTabs,
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
  archiveConstructorTasksAction,
  purgeConstructorTasksAction,
  restoreConstructorTasksAction,
} from './archive-actions';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  pageSize?: string;
  tab?: string;
}

/**
 * Список заявок конструктору (этап «Отправить изделие конструктору»).
 *
 * Источник данных — `GET /api/constructor-tasks`. Backend возвращает
 * все задачи без серверной пагинации (на MVP объём небольшой);
 * страницы делает клиентский `paginate()`.
 *
 * RBAC: страница доступна `ADMIN` / `SHOP_MANAGER`. RBAC реально
 * проверяется на бэкенде; на странице мы просто показываем ошибку
 * 403 или 401 как любую другую сетевую ошибку.
 */
export default async function AdminConstructorTasksListPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  // Этап «Архив справочников»: активные заявки и архив
  // (`ConstructorTask.archivedAt`) — две вкладки над одной выдачей.
  const tab: 'active' | 'archive' =
    searchParams?.tab === 'archive' ? 'archive' : 'active';

  let all: ConstructorTaskSummaryDto[] = [];
  let error: string | null = null;
  try {
    all = await listConstructorTasks();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список заявок конструктору';
  }

  const archivedItems = all.filter((t) => Boolean(t.archivedAt));
  const activeItems = all.filter((t) => !t.archivedAt);
  const items = tab === 'archive' ? archivedItems : activeItems;

  const { pageItems, page, pageSize, total } = paginate(items, searchParams);

  const columns: AdminTableColumn<ConstructorTaskSummaryDto>[] = [
    {
      key: 'select',
      header: <BulkArchiveSelectAll ids={pageItems.map((t) => t.id)} />,
      sortable: false,
      render: (t) => <BulkArchiveCheckbox id={t.id} />,
    },
    {
      key: 'patternName',
      header: 'Изделие',
      render: (t) => (
        <span className="admin-table__primary">
          {t.patternName}
          <span
            className="admin-muted"
            style={{ marginLeft: 6, fontSize: '0.8rem' }}
          >
            {t.patternArticle}
          </span>
        </span>
      ),
    },
    {
      key: 'sizes',
      header: 'Размеров',
      align: 'right',
      render: (t) => t.sizeRowsCount,
    },
    {
      key: 'files',
      header: 'Файлов',
      align: 'right',
      render: (t) => t.filesCount,
    },
    {
      key: 'createdBy',
      header: 'Кем создана',
      render: (t) =>
        t.createdByName ? (
          t.createdByName
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Создана',
      render: (t) => (
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {new Date(t.createdAt).toLocaleString('ru-RU')}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (t) => (
        <AdminStatusBadge tone={CONSTRUCTOR_TASK_STATUS_TONE[t.status]}>
          {CONSTRUCTOR_TASK_STATUS_LABELS[t.status]}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'archive',
      header: '',
      isAction: true,
      render: (t) => <BulkArchiveRowActions id={t.id} />,
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (t) => (
        <Link
          href={`/admin/constructor-tasks/${t.id}`}
          className="admin-table__action-link"
        >
          Открыть
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      ),
    },
  ];

  return (
    <AdminPageShell
      icon={<ClipboardList size={22} strokeWidth={1.6} aria-hidden />}
      title="Заявки конструктору"
      subtitle={`Активных: ${activeItems.length} · Архив: ${archivedItems.length}`}
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminArchiveTabs
          basePath="/admin/constructor-tasks"
          tab={tab}
          activeCount={activeItems.length}
          archiveCount={archivedItems.length}
        />

        <BulkArchiveProvider
          mode={tab}
          allIds={items.map((t) => t.id)}
          actions={{
            archive: archiveConstructorTasksAction,
            restore: restoreConstructorTasksAction,
            purge: purgeConstructorTasksAction,
          }}
          labels={{
            one: 'заявку',
            many: 'заявок',
            archiveHint:
              'Заявки пропадут из активного списка. История и вложения сохранятся, статус не меняется.',
            purgeHint:
              'Вместе с заявкой пропадут её строки размеров и вложения. Лекало (номенклатура) останется.',
          }}
        >
          <AdminSectionHeader
            title={tab === 'archive' ? 'Архив' : 'Активные'}
            hint={
              tab === 'archive'
                ? `В архиве: ${items.length}. Удаление навсегда — только отсюда.`
                : `Всего: ${items.length}`
            }
            actions={<BulkArchiveHeaderButton />}
          />

          <AdminTable
            rows={pageItems}
            columns={columns}
            rowKey={(t) => t.id}
            rowHref={(t) => `/admin/constructor-tasks/${t.id}`}
            emptyContent={
              tab === 'archive' ? (
                <AdminEmptyState
                  icon={
                    <ClipboardList size={26} strokeWidth={1.6} aria-hidden />
                  }
                  title="Архив пуст"
                  hint="Сюда попадают заявки, отправленные в архив. Из архива их можно вернуть или удалить навсегда."
                />
              ) : (
                <AdminEmptyState
                  icon={
                    <ClipboardList size={26} strokeWidth={1.6} aria-hidden />
                  }
                  title="Заявок конструктору пока нет"
                  hint="Они появляются автоматически после клика «Сохранить изделие» на вкладке «Отправить конструктору» в форме создания заказа."
                />
              )
            }
          />
        </BulkArchiveProvider>

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/constructor-tasks"
          preserveParams={{ tab: tab === 'archive' ? 'archive' : undefined }}
          label="заявок"
        />
      </AdminCard>
    </AdminPageShell>
  );
}
