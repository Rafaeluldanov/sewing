import Link from 'next/link';
import { Activity, ArrowRight, Plus } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { getRouteTemplate, listRouteTemplates } from '@/lib/routes-api';
import { getShiftMeta } from '@/lib/shifts-api';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import {
  AdminArchiveTabs,
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminRouteSteps,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  BulkArchiveCheckbox,
  BulkArchiveHeaderButton,
  BulkArchiveProvider,
  BulkArchiveSelectAll,
  BulkArchiveRowActions,
  paginate,
  type AdminRouteStep,
  type AdminTableColumn,
} from '@/components/admin';
import { formatStatus, statusTone } from '@/lib/admin-labels';
import {
  archiveRoutesAction,
  purgeRoutesAction,
  restoreRoutesAction,
} from './archive-actions';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  pageSize?: string;
  tab?: string;
}

interface RouteRow extends RouteTemplateSummaryDto {
  steps: AdminRouteStep[];
}

/**
 * Список шаблонов маршрутов производства (Admin UI 2.6).
 *
 * Backend / DTO не меняем — `GET /api/routes` отдаёт summary без
 * шагов, поэтому первые 4 операции по каждому видимому шаблону
 * подтягиваем параллельно через `getRouteTemplate(id)`. Шаблонов
 * в системе единицы-десятки, и страница уже `force-dynamic`,
 * поэтому N+1 здесь приемлемый компромисс ради компактного preview
 * без правки backend-а.
 */
export default async function AdminRoutesListPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const tab: 'active' | 'archive' =
    searchParams?.tab === 'archive' ? 'archive' : 'active';

  let all: RouteTemplateSummaryDto[] = [];
  let error: string | null = null;
  try {
    all = await listRouteTemplates();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список шаблонов маршрутов';
  }

  // Этап «Архив справочников»: активные (`isActive`) и архив — две
  // вкладки над одним и тем же списком, режем локально (backend отдаёт
  // все статусы), чтобы у обеих вкладок были счётчики за один запрос.
  const activeItems = all.filter((tpl) => tpl.isActive);
  const archivedItems = all.filter((tpl) => !tpl.isActive);
  const items = tab === 'archive' ? archivedItems : activeItems;

  const { pageItems, page, pageSize, total } = paginate(items, searchParams);

  let opCategoryById = new Map<string, string>();
  try {
    const meta = await getShiftMeta();
    opCategoryById = new Map(meta.operations.map((op) => [op.id, op.category]));
  } catch {
    opCategoryById = new Map();
  }

  const detailedRows: RouteRow[] = await Promise.all(
    pageItems.map(async (tpl) => {
      try {
        const detail = await getRouteTemplate(tpl.id);
        const steps = detail.steps
          .slice()
          .sort((a, b) => a.index - b.index)
          .map<AdminRouteStep>((s, i) => ({
            id: s.id,
            index: i + 1,
            name: s.operationName,
            category: opCategoryById.get(s.operationId) ?? null,
            parallelGroup: s.parallelGroup,
          }));
        return { ...tpl, steps };
      } catch {
        return { ...tpl, steps: [] };
      }
    }),
  );

  const columns: AdminTableColumn<RouteRow>[] = [
    {
      key: 'select',
      header: <BulkArchiveSelectAll ids={detailedRows.map((tpl) => tpl.id)} />,
      sortable: false,
      render: (tpl) => <BulkArchiveCheckbox id={tpl.id} />,
    },
    {
      key: 'name',
      header: 'Название',
      render: (tpl) => <span className="admin-table__primary">{tpl.name}</span>,
    },
    {
      key: 'steps',
      header: 'Операции',
      render: (tpl) =>
        tpl.steps.length === 0 ? (
          <AdminStatusBadge tone="warning">Пусто</AdminStatusBadge>
        ) : (
          <AdminRouteSteps steps={tpl.steps} maxVisible={4} dense />
        ),
    },
    {
      key: 'updatedAt',
      header: 'Обновлён',
      render: (tpl) => (
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {new Date(tpl.updatedAt).toLocaleString('ru-RU')}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (tpl) => (
        <AdminStatusBadge tone={statusTone(tpl.isActive)}>
          {formatStatus(tpl.isActive)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'archive',
      header: '',
      isAction: true,
      render: (tpl) => <BulkArchiveRowActions id={tpl.id} />,
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (tpl) => (
        <Link
          href={`/admin/routes/${tpl.id}`}
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
      icon={<Activity size={22} strokeWidth={1.6} aria-hidden />}
      title="Маршруты"
      subtitle={`Активных: ${activeItems.length} · Архив: ${archivedItems.length}`}
      actions={
        <Link href="/admin/routes/new" className="admin-btn admin-btn--primary">
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          Новый шаблон
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
          basePath="/admin/routes"
          tab={tab}
          activeCount={activeItems.length}
          archiveCount={archivedItems.length}
        />

        <BulkArchiveProvider
          mode={tab}
          allIds={items.map((tpl) => tpl.id)}
          actions={{
            archive: archiveRoutesAction,
            restore: restoreRoutesAction,
            purge: purgeRoutesAction,
          }}
          labels={{
            one: 'маршрут',
            many: 'маршрутов',
            archiveHint:
              'Шаблоны пропадут из активного списка и перестанут предлагаться в заказах. Запущенные заказы работают по своему снимку маршрута и не пострадают.',
            purgeHint: 'Вместе с шаблоном пропадёт его набор операций.',
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
            rows={detailedRows}
            columns={columns}
            rowKey={(tpl) => tpl.id}
            rowHref={(tpl) => `/admin/routes/${tpl.id}`}
            emptyContent={
              tab === 'archive' ? (
                <AdminEmptyState
                  icon={<Activity size={26} strokeWidth={1.6} aria-hidden />}
                  title="Архив пуст"
                  hint="Сюда попадают шаблоны маршрутов, отправленные в архив. Из архива их можно вернуть или удалить навсегда."
                />
              ) : (
                <AdminEmptyState
                  icon={<Activity size={26} strokeWidth={1.6} aria-hidden />}
                  title="Шаблонов маршрутов нет"
                  actions={
                    <Link
                      href="/admin/routes/new"
                      className="admin-btn admin-btn--primary"
                    >
                      <Plus size={16} strokeWidth={1.6} aria-hidden />
                      Новый шаблон
                    </Link>
                  }
                />
              )
            }
          />
        </BulkArchiveProvider>

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/routes"
          preserveParams={{ tab: tab === 'archive' ? 'archive' : undefined }}
          label="шаблонов"
        />
      </AdminCard>
    </AdminPageShell>
  );
}
