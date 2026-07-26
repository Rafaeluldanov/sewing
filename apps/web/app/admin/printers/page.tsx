import Link from 'next/link';
import { ArrowRight, Plus, Printer } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { listPrinters } from '@/lib/printers-api';
import type { PrinterSummaryDto } from '@sewing/shared/printers';
import { formatRole } from '@/lib/admin-labels';
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
  BulkArchiveRowActions,
  paginate,
  type AdminTableColumn,
} from '@/components/admin';
import {
  archivePrintersAction,
  purgePrintersAction,
  restorePrintersAction,
} from './archive-actions';

export const dynamic = 'force-dynamic';

const PRINTER_TYPE_LABEL: Record<string, string> = {
  DEFAULT: 'По умолчанию',
  WINDOWS: 'Windows',
  ZEBRA: 'Zebra',
};

function formatPrinterType(type: string): string {
  return PRINTER_TYPE_LABEL[type] ?? type;
}

interface SearchParams {
  page?: string;
  pageSize?: string;
  tab?: string;
}

/**
 * Список принтеров (Admin UI Polish).
 *
 * Источник истины — `GET /api/printers`. Доступ режется в
 * `app/admin/layout.tsx` (ADMIN/SHOP_MANAGER); backend параллельно
 * проверяет `@Roles('ADMIN', 'SHOP_MANAGER')`.
 *
 * UI Polish:
 *   - убрали технический `code` оборудования из колонки «Рабочее место»
 *     (видим в карточке оборудования);
 *   - типы (DEFAULT/WINDOWS/ZEBRA) переведены через `PRINTER_TYPE_LABEL`;
 *   - онлайн/офлайн — `<AdminStatusBadge>` с тоном по статусу.
 */
export default async function AdminPrintersPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const tab: 'active' | 'archive' =
    searchParams?.tab === 'archive' ? 'archive' : 'active';

  let items: PrinterSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listPrinters();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список принтеров';
  }

  // Этап «Архив справочников»: архив принтера — `isActive = false`
  // (агент такого принтера уже не спарится).
  const activeItems = items.filter((p) => p.isActive);
  const archivedItems = items.filter((p) => !p.isActive);
  const visible = tab === 'archive' ? archivedItems : activeItems;

  const { pageItems, page, pageSize, total } = paginate(visible, searchParams);

  const columns: AdminTableColumn<PrinterSummaryDto>[] = [
    {
      key: 'select',
      header: '',
      sortable: false,
      render: (p) => <BulkArchiveCheckbox id={p.id} />,
    },
    {
      key: 'name',
      header: 'Название',
      render: (p) => (
        <div>
          <Link
            href={`/admin/printers/${p.id}`}
            className="admin-table__primary"
            style={{ color: 'var(--admin-text)', textDecoration: 'none' }}
          >
            {p.name}
          </Link>
          {!p.isActive && <div className="admin-table__hint">В архиве</div>}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Тип',
      render: (p) => formatPrinterType(p.type),
    },
    {
      key: 'role',
      header: 'Роль',
      render: (p) =>
        p.role ? (
          <span>{formatRole(p.role)}</span>
        ) : (
          <span className="admin-muted">Не привязан</span>
        ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (p) =>
        p.isOnline ? (
          <AdminStatusBadge tone="success" withDot>
            Онлайн
          </AdminStatusBadge>
        ) : (
          <AdminStatusBadge tone="muted" withDot>
            Офлайн
          </AdminStatusBadge>
        ),
    },
    {
      key: 'queue',
      header: 'В очереди',
      align: 'right',
      render: (p) =>
        p.pendingJobsCount === 0 ? (
          <span className="admin-muted">—</span>
        ) : (
          <strong>{p.pendingJobsCount}</strong>
        ),
    },
    {
      key: 'archive',
      header: '',
      isAction: true,
      render: (p) => <BulkArchiveRowActions id={p.id} />,
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (p) => (
        <Link
          href={`/admin/printers/${p.id}`}
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
      icon={<Printer size={22} strokeWidth={1.6} aria-hidden />}
      title="Принтеры"
      subtitle={`Активных: ${activeItems.length} · Архив: ${archivedItems.length}`}
      actions={
        <Link
          href="/admin/printers/new"
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
        <AdminArchiveTabs
          basePath="/admin/printers"
          tab={tab}
          activeCount={activeItems.length}
          archiveCount={archivedItems.length}
        />

        <BulkArchiveProvider
          mode={tab}
          allIds={visible.map((p) => p.id)}
          actions={{
            archive: archivePrintersAction,
            restore: restorePrintersAction,
            purge: purgePrintersAction,
          }}
          labels={{
            one: 'принтер',
            many: 'принтеров',
            archiveHint:
              'Принтеры пропадут из активного списка, их агенты перестанут спариваться.',
            purgeHint: 'Вместе с принтером пропадёт его очередь заданий печати.',
          }}
        >
          <AdminSectionHeader
            title={tab === 'archive' ? 'Архив' : 'Активные'}
            hint={
              tab === 'archive'
                ? `В архиве: ${visible.length}. Удаление навсегда — только отсюда.`
                : `Всего: ${visible.length}`
            }
            actions={<BulkArchiveHeaderButton />}
          />

          <AdminTable
            rows={pageItems}
            columns={columns}
            rowKey={(p) => p.id}
            rowHref={(p) => `/admin/printers/${p.id}`}
            emptyContent={
              tab === 'archive' ? (
                <AdminEmptyState
                  icon={<Printer size={26} strokeWidth={1.6} aria-hidden />}
                  title="Архив пуст"
                  hint="Сюда попадают принтеры, отправленные в архив. Из архива их можно вернуть или удалить навсегда."
                />
              ) : (
                <AdminEmptyState
                  icon={<Printer size={26} strokeWidth={1.6} aria-hidden />}
                  title="Принтеров ещё нет"
                  actions={
                    <Link
                      href="/admin/printers/new"
                      className="admin-btn admin-btn--primary"
                    >
                      <Plus size={16} strokeWidth={1.6} aria-hidden />
                      Добавить принтер
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
          basePath="/admin/printers"
          preserveParams={{ tab: tab === 'archive' ? 'archive' : undefined }}
          label="принтеров"
        />
      </AdminCard>
    </AdminPageShell>
  );
}
