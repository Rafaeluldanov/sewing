import Link from 'next/link';
import { ArrowRight, ClipboardList, Plus } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { listTechCards } from '@/lib/tech-cards-api';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
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
import { formatStatus, statusTone } from '@/lib/admin-labels';
import {
  archiveTechCardsAction,
  purgeTechCardsAction,
  restoreTechCardsAction,
} from './archive-actions';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  pageSize?: string;
  tab?: string;
}

/**
 * Список шаблонов техкарт (Admin UI 2.5, ADR-0022).
 *
 * Этап «Архив справочников»: две вкладки — «Активные» (`isActive`) и
 * «Архив». Backend отдаёт все статусы одним запросом, режем локально —
 * так у обеих вкладок есть счётчики без второго round-trip-а.
 * Массовые операции архива — `BulkArchiveProvider` (общий компонент на
 * все девять справочников). Пагинация — клиентская через `paginate()`.
 */
export default async function AdminTechCardsListPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const tab: 'active' | 'archive' =
    searchParams?.tab === 'archive' ? 'archive' : 'active';

  let all: TechCardTemplateSummaryDto[] = [];
  let error: string | null = null;
  try {
    all = await listTechCards();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список техкарт';
  }

  const activeItems = all.filter((tc) => tc.isActive);
  const archivedItems = all.filter((tc) => !tc.isActive);
  const items = tab === 'archive' ? archivedItems : activeItems;

  const { pageItems, page, pageSize, total } = paginate(items, searchParams);

  const columns: AdminTableColumn<TechCardTemplateSummaryDto>[] = [
    {
      key: 'select',
      header: <BulkArchiveSelectAll ids={pageItems.map((tc) => tc.id)} />,
      sortable: false,
      render: (tc) => <BulkArchiveCheckbox id={tc.id} />,
    },
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
      key: 'archive',
      header: '',
      isAction: true,
      render: (tc) => <BulkArchiveRowActions id={tc.id} />,
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
      subtitle={`Активных: ${activeItems.length} · Архив: ${archivedItems.length}`}
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
        <AdminArchiveTabs
          basePath="/admin/tech-cards"
          tab={tab}
          activeCount={activeItems.length}
          archiveCount={archivedItems.length}
        />

        <BulkArchiveProvider
          mode={tab}
          allIds={items.map((tc) => tc.id)}
          actions={{
            archive: archiveTechCardsAction,
            restore: restoreTechCardsAction,
            purge: purgeTechCardsAction,
          }}
          labels={{
            one: 'техкарту',
            many: 'техкарт',
            archiveHint:
              'Техкарты пропадут из активного справочника и перестанут предлагаться в заказах.',
            purgeHint:
              'Вместе с картой пропадут её строки материалов и внешних работ.',
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
            rowKey={(tc) => tc.id}
            rowHref={(tc) => `/admin/tech-cards/${tc.id}`}
            emptyContent={
              tab === 'archive' ? (
                <AdminEmptyState
                  icon={
                    <ClipboardList size={26} strokeWidth={1.6} aria-hidden />
                  }
                  title="Архив пуст"
                  hint="Сюда попадают техкарты, отправленные в архив. Из архива их можно вернуть или удалить навсегда."
                />
              ) : (
                <AdminEmptyState
                  icon={
                    <ClipboardList size={26} strokeWidth={1.6} aria-hidden />
                  }
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
              )
            }
          />
        </BulkArchiveProvider>

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/tech-cards"
          preserveParams={{ tab: tab === 'archive' ? 'archive' : undefined }}
          label="техкарт"
        />
      </AdminCard>
    </AdminPageShell>
  );
}
