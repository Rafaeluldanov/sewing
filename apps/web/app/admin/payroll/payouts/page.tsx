import Link from 'next/link';
import {
  ArrowRight,
  BadgeRussianRuble,
  Filter,
  Plus,
  RotateCcw,
} from 'lucide-react';
import {
  PAYROLL_PAYOUT_STATUSES,
  type PayrollPayoutDto,
  type PayrollPayoutStatus,
} from '@sewing/shared/payroll-payouts';
import { ApiRequestError } from '@/lib/api';
import { listPayrollPayouts } from '@/lib/payroll-payouts-api';
import { listEmployees } from '@/lib/employees-api';
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
  getPayoutStatusLabel,
  getPayoutStatusTone,
} from './payout-ui';

export const dynamic = 'force-dynamic';

interface SearchParams {
  employeeId?: string;
  status?: string;
  periodFrom?: string;
  periodTo?: string;
  page?: string;
}

/**
 * Список выплат зарплаты (PHASE 3 STEP 4).
 *
 * Менеджер видит все выплаты с фильтрами по сотруднику, статусу и
 * периоду. Создание — кнопка «Создать выплату» → `/admin/payroll/payouts/new`.
 */
export default async function AdminPayrollPayoutsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const today = todayIso();
  const monthStart = monthStartIso();

  const employeeId = searchParams?.employeeId?.trim() || undefined;
  const status = parsePayoutStatus(searchParams?.status);
  const periodFrom = searchParams?.periodFrom?.trim() || monthStart;
  const periodTo = searchParams?.periodTo?.trim() || today;
  const page = Math.max(1, Number(searchParams?.page ?? '1') || 1);
  const pageSize = 50;

  let response = null;
  let error: string | null = null;
  try {
    response = await listPayrollPayouts({
      employeeId,
      status,
      periodFrom,
      periodTo,
      page,
      pageSize,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список выплат';
  }

  const employeesList = await listEmployees({ active: true }).catch(() => []);

  const items = response?.items ?? [];
  const total = response?.total ?? 0;

  const preserveParams: Record<string, string | undefined> = {
    employeeId,
    status: status ?? undefined,
    periodFrom,
    periodTo,
  };

  const columns: AdminTableColumn<PayrollPayoutDto>[] = [
    {
      key: 'employee',
      header: 'Сотрудник',
      render: (r) => (
        <div className="admin-table__primary">
          {r.employee?.fullName ?? r.employeeId}
          {r.employee?.role && (
            <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
              {r.employee.role}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'period',
      header: 'Период',
      render: (r) => `${formatDate(r.periodFrom)} – ${formatDate(r.periodTo)}`,
    },
    {
      key: 'status',
      header: 'Статус',
      render: (r) => (
        <AdminStatusBadge tone={getPayoutStatusTone(r.status)} withDot>
          {getPayoutStatusLabel(r.status)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'piecework',
      header: 'Сдельно, ₽',
      align: 'right',
      render: (r) =>
        r.amountPieceworkRub > 0 ? (
          formatRub(r.amountPieceworkRub)
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'salary',
      header: 'Оклад, ₽',
      align: 'right',
      render: (r) =>
        r.amountSalaryRub > 0 ? (
          formatRub(r.amountSalaryRub)
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'total',
      header: 'Итого, ₽',
      align: 'right',
      render: (r) => <strong>{formatRub(r.amountTotalRub)}</strong>,
    },
    {
      key: 'createdAt',
      header: 'Создано',
      render: (r) => (
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {formatDateTime(r.createdAt)}
        </span>
      ),
    },
    {
      key: 'issuedAt',
      header: 'Выдано',
      render: (r) => (
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {formatDateTime(r.issuedAt)}
        </span>
      ),
    },
    {
      key: 'acknowledgedAt',
      header: 'Подтверждено',
      render: (r) => (
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {formatDateTime(r.acknowledgedAt)}
        </span>
      ),
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (r) => (
        <Link
          href={`/admin/payroll/payouts/${r.id}`}
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
      icon={<BadgeRussianRuble size={22} strokeWidth={1.6} aria-hidden />}
      title="Выплаты зарплаты"
      subtitle="Управление выплатами сотрудникам (PHASE 3)"
      actions={
        <Link
          href="/admin/payroll/payouts/new"
          className="admin-btn admin-btn--primary"
        >
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          Создать выплату
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader title="Фильтры" />
        <form method="get" className="admin-form-grid" role="search">
          <div className="admin-field">
            <label htmlFor="payout-employee">Сотрудник</label>
            <select
              id="payout-employee"
              name="employeeId"
              defaultValue={employeeId ?? ''}
            >
              <option value="">— все —</option>
              {employeesList.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="payout-status">Статус</label>
            <select
              id="payout-status"
              name="status"
              defaultValue={status ?? ''}
            >
              <option value="">— любой —</option>
              {PAYROLL_PAYOUT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {getPayoutStatusLabel(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="payout-period-from">Период с</label>
            <input
              id="payout-period-from"
              type="date"
              name="periodFrom"
              defaultValue={periodFrom}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="payout-period-to">По</label>
            <input
              id="payout-period-to"
              type="date"
              name="periodTo"
              defaultValue={periodTo}
            />
          </div>
          <div
            className="admin-field"
            style={{
              flexDirection: 'row',
              gap: '0.5rem',
              alignItems: 'flex-end',
            }}
          >
            <button type="submit" className="admin-btn admin-btn--primary">
              <Filter size={14} strokeWidth={1.6} aria-hidden />
              Применить
            </button>
            <Link
              href="/admin/payroll/payouts"
              className="admin-btn admin-btn--ghost"
            >
              <RotateCcw size={14} strokeWidth={1.6} aria-hidden />
              Сбросить
            </Link>
          </div>
        </form>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Выплаты" hint={`${total} шт.`} />
        <AdminTable
          rows={items}
          columns={columns}
          rowKey={(r) => r.id}
          emptyContent={
            <AdminEmptyState
              icon={
                <BadgeRussianRuble size={26} strokeWidth={1.6} aria-hidden />
              }
              title="Выплат нет"
              hint="Создайте первую выплату для сотрудника"
            />
          }
        />
        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/payroll/payouts"
          preserveParams={preserveParams}
          label="выплат"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

function parsePayoutStatus(
  value: string | undefined,
): PayrollPayoutStatus | undefined {
  if (!value) return undefined;
  return (PAYROLL_PAYOUT_STATUSES as readonly string[]).includes(value)
    ? (value as PayrollPayoutStatus)
    : undefined;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function monthStartIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}
