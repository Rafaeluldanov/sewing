import Link from 'next/link';
import { Activity, ArrowRight, Plus } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getRouteTemplate, listRouteTemplates } from '@/lib/routes-api';
import { getShiftMeta } from '@/lib/shifts-api';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminRouteSteps,
  AdminStatusBadge,
  AdminTable,
  paginate,
  type AdminRouteStep,
  type AdminTableColumn,
} from '@/components/admin';
import { formatStatus, statusTone } from '@/lib/admin-labels';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  pageSize?: string;
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
  let items: RouteTemplateSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listRouteTemplates();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список шаблонов маршрутов';
  }

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
          }));
        return { ...tpl, steps };
      } catch {
        return { ...tpl, steps: [] };
      }
    }),
  );

  const columns: AdminTableColumn<RouteRow>[] = [
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
      subtitle={`Всего: ${items.length}`}
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
        <AdminTable
          rows={detailedRows}
          columns={columns}
          rowKey={(tpl) => tpl.id}
          emptyContent={
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
          }
        />

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/routes"
          label="шаблонов"
        />
      </AdminCard>
    </AdminPageShell>
  );
}
