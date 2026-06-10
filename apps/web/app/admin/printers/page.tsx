import Link from 'next/link';
import { ArrowRight, Plus, Printer } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { listPrinters } from '@/lib/printers-api';
import type { PrinterSummaryDto } from '@sewing/shared/printers';
import { formatRole } from '@/lib/admin-labels';
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

  const { pageItems, page, pageSize, total } = paginate(items, searchParams);

  const columns: AdminTableColumn<PrinterSummaryDto>[] = [
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
          {!p.isActive && (
            <div className="admin-table__hint">Деактивирован</div>
          )}
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
      subtitle={`Всего: ${items.length}`}
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
        <AdminTable
          rows={pageItems}
          columns={columns}
          rowKey={(p) => p.id}
          emptyContent={
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
          }
        />

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/printers"
          label="принтеров"
        />
      </AdminCard>
    </AdminPageShell>
  );
}
