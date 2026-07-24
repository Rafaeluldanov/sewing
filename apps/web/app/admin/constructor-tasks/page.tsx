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
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminStatusBadge,
  AdminTable,
  paginate,
  type AdminTableColumn,
} from '@/components/admin';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  pageSize?: string;
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
  let items: ConstructorTaskSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listConstructorTasks();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список заявок конструктору';
  }

  const { pageItems, page, pageSize, total } = paginate(items, searchParams);

  const columns: AdminTableColumn<ConstructorTaskSummaryDto>[] = [
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
      subtitle={`Всего: ${items.length}`}
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminTable
          rows={pageItems}
          columns={columns}
          rowKey={(t) => t.id}
          rowHref={(t) => `/admin/constructor-tasks/${t.id}`}
          emptyContent={
            <AdminEmptyState
              icon={<ClipboardList size={26} strokeWidth={1.6} aria-hidden />}
              title="Заявок конструктору пока нет"
              hint="Они появляются автоматически после клика «Сохранить изделие» на вкладке «Отправить конструктору» в форме создания заказа."
            />
          }
        />

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/constructor-tasks"
          label="заявок"
        />
      </AdminCard>
    </AdminPageShell>
  );
}
