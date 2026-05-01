import Link from 'next/link';
import { ArrowRight, Plus, Warehouse } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { listWarehouses } from '@/lib/warehouses-api';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
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
import { formatStatus, statusTone } from '@/lib/admin-labels';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  pageSize?: string;
}

/**
 * Список складов (Admin UI 2.5).
 *
 * Backend / DTO не меняем. Пагинация — клиентская через `paginate()`.
 */
export default async function AdminWarehousesListPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  let items: WarehouseSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listWarehouses();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список складов';
  }

  const { pageItems, page, pageSize, total } = paginate(items, searchParams);

  const columns: AdminTableColumn<WarehouseSummaryDto>[] = [
    {
      key: 'name',
      header: 'Название',
      render: (w) => <span className="admin-table__primary">{w.name}</span>,
    },
    {
      key: 'cells',
      header: 'Ячеек',
      align: 'right',
      render: (w) =>
        w.cellsCount === 0 ? (
          <span className="admin-muted">0</span>
        ) : (
          w.cellsCount
        ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (w) => (
        <AdminStatusBadge tone={statusTone(w.isActive)}>
          {formatStatus(w.isActive)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (w) => (
        <Link
          href={`/admin/warehouses/${w.id}`}
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
      icon={<Warehouse size={22} strokeWidth={1.6} aria-hidden />}
      title="Склады"
      subtitle={`Всего: ${items.length}`}
      actions={
        <Link
          href="/admin/warehouses/new"
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
        <AdminTable
          rows={pageItems}
          columns={columns}
          rowKey={(w) => w.id}
          emptyContent={
            <AdminEmptyState
              icon={<Warehouse size={26} strokeWidth={1.6} aria-hidden />}
              title="Складов пока нет"
              hint="Создайте первый склад — это займёт меньше минуты."
              actions={
                <Link
                  href="/admin/warehouses/new"
                  className="admin-btn admin-btn--primary"
                >
                  <Plus size={16} strokeWidth={1.6} aria-hidden />
                  Добавить склад
                </Link>
              }
            />
          }
        />

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/warehouses"
          label="складов"
        />
      </AdminCard>
    </AdminPageShell>
  );
}
