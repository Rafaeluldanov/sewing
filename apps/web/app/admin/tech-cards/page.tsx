import Link from 'next/link';
import { ArrowRight, ClipboardList, Plus } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { listTechCards } from '@/lib/tech-cards-api';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
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
 * Список шаблонов техкарт (Admin UI 2.5, ADR-0022).
 *
 * Backend / DTO не меняем. Пагинация — клиентская через `paginate()`.
 */
export default async function AdminTechCardsListPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  let items: TechCardTemplateSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listTechCards();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список техкарт';
  }

  const { pageItems, page, pageSize, total } = paginate(items, searchParams);

  const columns: AdminTableColumn<TechCardTemplateSummaryDto>[] = [
    {
      key: 'name',
      header: 'Название',
      render: (tc) => <span className="admin-table__primary">{tc.name}</span>,
    },
    {
      key: 'materials',
      header: 'Материалов',
      align: 'right',
      render: (tc) => tc.materialLinesCount,
    },
    {
      key: 'outsource',
      header: 'Внешних',
      align: 'right',
      render: (tc) => tc.outsourceLinesCount,
    },
    {
      key: 'updatedAt',
      header: 'Обновлена',
      render: (tc) => (
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {new Date(tc.updatedAt).toLocaleString('ru-RU')}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (tc) => (
        <AdminStatusBadge tone={statusTone(tc.isActive)}>
          {formatStatus(tc.isActive)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (tc) => (
        <Link
          href={`/admin/tech-cards/${tc.id}`}
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
      title="Техкарты"
      subtitle={`Всего: ${items.length}`}
      actions={
        <Link
          href="/admin/tech-cards/new"
          className="admin-btn admin-btn--primary"
        >
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          Новая техкарта
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
          rowKey={(tc) => tc.id}
          emptyContent={
            <AdminEmptyState
              icon={<ClipboardList size={26} strokeWidth={1.6} aria-hidden />}
              title="Техкарты ещё не заведены"
              hint="Создайте первую — например, «Базовая футболка»."
              actions={
                <Link
                  href="/admin/tech-cards/new"
                  className="admin-btn admin-btn--primary"
                >
                  <Plus size={16} strokeWidth={1.6} aria-hidden />
                  Новая техкарта
                </Link>
              }
            />
          }
        />

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/tech-cards"
          label="техкарт"
        />
      </AdminCard>
    </AdminPageShell>
  );
}
