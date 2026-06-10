import Link from 'next/link';
import { ArrowRight, BadgeRussianRuble, Filter, Plus } from 'lucide-react';
import {
  PAYROLL_ACCRUAL_DOCUMENT_STATUSES,
  type PayrollAccrualDocumentListItemDto,
  type PayrollAccrualDocumentStatus,
} from '@sewing/shared/payroll-accrual-documents';
import { ApiRequestError, errorText } from '@/lib/api';
import { listPayrollAccrualDocuments } from '@/lib/payroll-accrual-documents-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import {
  formatDate,
  formatDateTime,
  formatRub,
  formatSignedRub,
  getAccrualDocumentStatusLabel,
  getAccrualDocumentStatusTone,
} from './accrual-document-ui';

export const dynamic = 'force-dynamic';

interface SearchParams {
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: string;
}

/**
 * Список документов начисления зарплаты (PHASE 3 STEP 6.3).
 *
 * Менеджер видит все документы с фильтрами по статусу и дате.
 * Создание — кнопка «Начислить зарплату» → `/admin/payroll/accrual-documents/new`.
 */
export default async function AdminAccrualDocumentsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const status = parseDocumentStatus(searchParams?.status);
  const dateFrom = searchParams?.dateFrom?.trim() || undefined;
  const dateTo = searchParams?.dateTo?.trim() || undefined;
  const page = Math.max(1, Number(searchParams?.page ?? '1') || 1);
  const pageSize = 50;

  let response = null;
  let error: string | null = null;
  try {
    response = await listPayrollAccrualDocuments({
      status,
      dateFrom,
      dateTo,
      page,
      pageSize,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить документы начисления';
  }

  const items = response?.items ?? [];
  const total = response?.total ?? 0;

  const columns: AdminTableColumn<PayrollAccrualDocumentListItemDto>[] = [
    {
      key: 'accrualDate',
      header: 'Дата начисления',
      render: (d) => formatDate(d.accrualDate),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (d) => (
        <AdminStatusBadge tone={getAccrualDocumentStatusTone(d.status)} withDot>
          {getAccrualDocumentStatusLabel(d.status)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'linesCount',
      header: 'Сотрудников',
      align: 'right',
      render: (d) => String(d.linesCount),
    },
    {
      key: 'piecework',
      header: 'Сдельно',
      align: 'right',
      render: (d) => formatRub(d.totalPieceworkRub),
    },
    {
      key: 'salary',
      header: 'Оклад',
      align: 'right',
      render: (d) => formatRub(d.totalSalaryRub),
    },
    {
      key: 'adjust',
      header: 'Корректировки',
      align: 'right',
      render: (d) =>
        d.totalAdjustRub !== 0 ? formatSignedRub(d.totalAdjustRub) : '—',
    },
    {
      key: 'total',
      header: 'Итого к выплате',
      align: 'right',
      render: (d) => <strong>{formatRub(d.totalToPayRub)}</strong>,
    },
    {
      key: 'createdAt',
      header: 'Создано',
      render: (d) => formatDateTime(d.createdAt),
    },
    {
      key: 'paidAt',
      header: 'Выплачено',
      render: (d) => formatDateTime(d.paidAt),
    },
    {
      key: 'action',
      header: '',
      render: (d) => (
        <Link
          href={`/admin/payroll/accrual-documents/${d.id}`}
          className="admin-btn admin-btn--ghost admin-btn--sm"
        >
          Открыть
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      ),
    },
  ];

  return (
    <AdminPageShell
      icon={<BadgeRussianRuble size={22} strokeWidth={1.6} aria-hidden />}
      title="Документы начисления зарплаты"
      actions={
        <>
          <Link
            href="/admin/payroll/accrual-documents/new"
            className="admin-btn admin-btn--primary"
          >
            <Plus size={16} strokeWidth={1.6} aria-hidden />
            Начислить зарплату
          </Link>
          <Link href="/admin/payroll" className="admin-btn admin-btn--ghost">
            ← Зарплата
          </Link>
        </>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {/* Фильтры */}
      <AdminCard>
        <AdminSectionHeader
          title="Фильтры"
          icon={<Filter size={16} strokeWidth={1.6} aria-hidden />}
        />
        <form method="get" className="admin-form-grid" role="search">
          <div className="admin-field">
            <label htmlFor="ad-status">Статус</label>
            <select
              id="ad-status"
              name="status"
              defaultValue={status ?? ''}
            >
              <option value="">— любой —</option>
              {PAYROLL_ACCRUAL_DOCUMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {getAccrualDocumentStatusLabel(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="ad-date-from">Дата с</label>
            <input
              id="ad-date-from"
              type="date"
              name="dateFrom"
              defaultValue={dateFrom ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="ad-date-to">Дата по</label>
            <input
              id="ad-date-to"
              type="date"
              name="dateTo"
              defaultValue={dateTo ?? ''}
            />
          </div>
          <div
            className="admin-field"
            style={{ flexDirection: 'row', alignItems: 'flex-end' }}
          >
            <button type="submit" className="admin-btn">
              <Filter size={14} strokeWidth={1.6} aria-hidden />
              Применить
            </button>
            <Link href="/admin/payroll/accrual-documents" className="admin-btn admin-btn--ghost">
              Сбросить
            </Link>
          </div>
        </form>
      </AdminCard>

      {/* Таблица */}
      <AdminCard>
        <AdminSectionHeader
          title="Документы"
          hint={total > 0 ? `${total} записей` : undefined}
        />
        <AdminTable
          rows={items}
          columns={columns}
          rowKey={(d) => d.id}
          emptyContent={
            <AdminEmptyState
              icon={
                <BadgeRussianRuble size={24} strokeWidth={1.6} aria-hidden />
              }
              title="Документов начисления пока нет"
              hint="Нажмите «Начислить зарплату», чтобы сформировать первый документ"
            />
          }
        />
      </AdminCard>

      {total > pageSize && (
      <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/payroll/accrual-documents"
          preserveParams={{ status: status ?? undefined, dateFrom, dateTo }}
        />
      )}
    </AdminPageShell>
  );
}

function parseDocumentStatus(
  value: string | undefined,
): PayrollAccrualDocumentStatus | undefined {
  if (!value) return undefined;
  const statuses: readonly string[] = PAYROLL_ACCRUAL_DOCUMENT_STATUSES;
  return statuses.includes(value)
    ? (value as PayrollAccrualDocumentStatus)
    : undefined;
}
