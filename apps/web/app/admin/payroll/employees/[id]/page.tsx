import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Filter,
  RotateCcw,
  Users,
} from 'lucide-react';
import type {
  PayrollEmployeeDetailDto,
  PayrollEmployeeOperationEntryDto,
  PayrollEmployeeSalaryEntryDto,
  PayrollEmployeeShiftDto,
} from '@sewing/shared/payroll';
import { ApiRequestError } from '@/lib/api';
import { getPayrollEmployee } from '@/lib/payroll-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { formatCompensation, formatRole } from '@/lib/admin-labels';
import { EARNING_STATUS_LABELS } from '@/lib/earnings-api';

export const dynamic = 'force-dynamic';

interface SearchParams {
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Карточка сотрудника `/admin/payroll/employees/:id` (PHASE 1, read-only).
 *
 * Контракт API — `docs/api.md §10c` (`/api/payroll/employees/:id`).
 * UX — `docs/screens.md §12a`.
 *
 * Drill-down с `/admin/payroll` и `/admin/payroll/daily`. Показывает:
 *   - реквизиты сотрудника;
 *   - summary за период (approved/pending по сдельщине + оклад);
 *   - таблицу смен;
 *   - таблицу `OperationEntry` (с разделением approved/pending);
 *   - таблицу `SalaryEntry` (с подсветкой ручной правки).
 *
 * Никаких мутаций — менеджер правит оклад в `/earnings` (через
 * `SalaryEntryEditor`), карточку сотрудника — в
 * `/admin/employees/:id`.
 */
export default async function AdminPayrollEmployeePage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: SearchParams;
}) {
  const today = formatDateOnlyToday();
  const monthStart = formatDateOnlyMonthStart();
  const dateFrom = searchParams?.dateFrom?.trim() || monthStart;
  const dateTo = searchParams?.dateTo?.trim() || today;

  let detail: PayrollEmployeeDetailDto | null = null;
  let error: string | null = null;
  try {
    detail = await getPayrollEmployee(params.id, { dateFrom, dateTo });
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить карточку сотрудника';
  }

  const employee = detail?.employee ?? null;
  const summary = detail?.summary ?? null;

  return (
    <AdminPageShell
      icon={<Users size={22} strokeWidth={1.6} aria-hidden />}
      title={employee?.fullName ?? 'Сотрудник'}
      subtitle={
        employee
          ? `${formatRole(employee.role)} · ${formatCompensation(employee.compensationType)}`
          : undefined
      }
      actions={
        <>
          <Link
            href="/admin/payroll"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К ведомости
          </Link>
          {employee && (
            <Link
              href={`/admin/employees/${employee.employeeId}`}
              className="admin-btn"
            >
              Карточка сотрудника
              <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
            </Link>
          )}
        </>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {summary && (
        <div className="kpi-grid">
          <Kpi
            label="Всего за период"
            value={formatRub(summary.totalRub)}
            sub={`${summary.daysOnShift} дн. · ${summary.entriesCount} строк`}
            tone="accent"
          />
          <Kpi
            label="Утверждено"
            value={formatRub(summary.totalApprovedRub)}
            tone="ok"
          />
          <Kpi
            label="Ожидает"
            value={formatRub(summary.totalPendingRub)}
            tone="warn"
          />
          <Kpi label="Оклад" value={formatRub(summary.salaryRub)} />
          <Kpi
            label="Сдельно"
            value={formatRub(
              summary.pieceworkApprovedRub + summary.pieceworkPendingRub,
            )}
          />
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader title="Период" />
        <form method="get" className="admin-form-grid" role="search">
          <div className="admin-field">
            <label htmlFor="payroll-emp-from">С</label>
            <input
              id="payroll-emp-from"
              type="date"
              name="dateFrom"
              defaultValue={dateFrom}
              required
            />
          </div>
          <div className="admin-field">
            <label htmlFor="payroll-emp-to">По</label>
            <input
              id="payroll-emp-to"
              type="date"
              name="dateTo"
              defaultValue={dateTo}
              required
            />
          </div>
          <div
            className="admin-field"
            style={{ flexDirection: 'row', gap: '0.5rem', alignItems: 'flex-end' }}
          >
            <button type="submit" className="admin-btn admin-btn--primary">
              <Filter size={14} strokeWidth={1.6} aria-hidden />
              Применить
            </button>
            <Link
              href={`/admin/payroll/employees/${params.id}`}
              className="admin-btn admin-btn--ghost"
            >
              <RotateCcw size={14} strokeWidth={1.6} aria-hidden />
              Сбросить
            </Link>
          </div>
        </form>
      </AdminCard>

      {detail && (
        <>
          <AdminCard>
            <AdminSectionHeader
              title="Смены"
              hint={`${detail.shifts.length}`}
            />
            <ShiftsTable rows={detail.shifts} />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader
              title="Сдельные начисления"
              hint={`${detail.operationEntries.length}`}
            />
            <OperationEntriesTable rows={detail.operationEntries} />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader
              title="Окладные начисления"
              hint={`${detail.salaryEntries.length}`}
            />
            <SalaryEntriesTable rows={detail.salaryEntries} />
          </AdminCard>
        </>
      )}
    </AdminPageShell>
  );
}

function ShiftsTable({ rows }: { rows: PayrollEmployeeShiftDto[] }) {
  const columns: AdminTableColumn<PayrollEmployeeShiftDto>[] = [
    {
      key: 'date',
      header: 'Дата',
      render: (s) => formatDate(s.startedAt),
    },
    {
      key: 'started',
      header: 'Открыта',
      render: (s) => formatTime(s.startedAt),
    },
    {
      key: 'ended',
      header: 'Закрыта',
      render: (s) =>
        s.endedAt ? (
          formatTime(s.endedAt)
        ) : (
          <AdminStatusBadge tone="info">Открыта</AdminStatusBadge>
        ),
    },
    {
      key: 'equipment',
      header: 'Оборудование',
      render: (s) => (
        <span>
          {s.equipmentName}
          <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
            <code>{s.equipmentCode}</code>
          </div>
        </span>
      ),
    },
    {
      key: 'operation',
      header: 'Операция',
      render: (s) => (
        <span>
          {s.operationName}
          <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
            <code>{s.operationCode}</code>
          </div>
        </span>
      ),
    },
  ];
  return (
    <AdminTable
      rows={rows}
      columns={columns}
      rowKey={(s) => s.id}
      emptyContent={<AdminEmptyState title="За период смен не было" />}
    />
  );
}

function OperationEntriesTable({
  rows,
}: {
  rows: PayrollEmployeeOperationEntryDto[];
}) {
  const columns: AdminTableColumn<PayrollEmployeeOperationEntryDto>[] = [
    {
      key: 'date',
      header: 'Дата',
      render: (e) => formatDateTime(e.createdAt),
    },
    {
      key: 'operation',
      header: 'Операция',
      render: (e) => (
        <span>
          {e.operationName}
          <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
            <code>{e.operationCode}</code>
          </div>
        </span>
      ),
    },
    {
      key: 'passport',
      header: 'Паспорт',
      render: (e) => (
        <Link href={`/passports/${e.passportId}`}>{e.passportNumber}</Link>
      ),
    },
    {
      key: 'order',
      header: 'Заказ',
      render: (e) => <Link href={`/orders/${e.orderId}`}>{e.orderNumber}</Link>,
    },
    {
      key: 'qty',
      header: 'Кол-во',
      align: 'right',
      render: (e) => e.qty,
    },
    {
      key: 'rate',
      header: 'Ставка, ₽',
      align: 'right',
      render: (e) => formatMoney(e.ratePerUnit),
    },
    {
      key: 'amount',
      header: 'Сумма, ₽',
      align: 'right',
      render: (e) => <strong>{formatMoney(e.amount)}</strong>,
    },
    {
      key: 'status',
      header: 'Статус',
      render: (e) => (
        <AdminStatusBadge tone={statusTone(e.status)}>
          {EARNING_STATUS_LABELS[e.status]}
        </AdminStatusBadge>
      ),
    },
  ];
  return (
    <AdminTable
      rows={rows}
      columns={columns}
      rowKey={(e) => e.id}
      emptyContent={<AdminEmptyState title="Сдельных начислений нет" />}
    />
  );
}

function SalaryEntriesTable({
  rows,
}: {
  rows: PayrollEmployeeSalaryEntryDto[];
}) {
  const columns: AdminTableColumn<PayrollEmployeeSalaryEntryDto>[] = [
    {
      key: 'date',
      header: 'Дата',
      render: (s) => formatDate(`${s.date}T00:00:00.000Z`),
    },
    {
      key: 'source',
      header: 'Источник',
      render: (s) =>
        s.source === 'SHIFT_DAY' ? 'Оклад за смену' : 'Ручное',
    },
    {
      key: 'amount',
      header: 'Сумма, ₽',
      align: 'right',
      render: (s) => <strong>{formatMoney(s.amount)}</strong>,
    },
    {
      key: 'edited',
      header: 'Правка',
      render: (s) =>
        s.editedManually ? (
          <span>
            <AdminStatusBadge tone="warning">Вручную</AdminStatusBadge>
            {s.editedByFullName && (
              <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
                {s.editedByFullName}
              </div>
            )}
          </span>
        ) : (
          <span className="admin-muted">авто</span>
        ),
    },
    {
      key: 'comment',
      header: 'Комментарий',
      render: (s) =>
        s.managerComment ? (
          s.managerComment
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
  ];
  return (
    <AdminTable
      rows={rows}
      columns={columns}
      rowKey={(s) => s.id}
      emptyContent={<AdminEmptyState title="Окладных начислений нет" />}
    />
  );
}

function statusTone(
  status: PayrollEmployeeOperationEntryDto['status'],
): 'success' | 'warning' | 'danger' | 'muted' {
  switch (status) {
    case 'APPROVED':
      return 'success';
    case 'PENDING_RELEASE':
      return 'warning';
    case 'REVERSED':
      return 'danger';
    default:
      return 'muted';
  }
}

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'ok' | 'warn' | 'accent';
}) {
  const cls = `kpi-card${tone ? ` kpi-card--${tone}` : ''}`;
  return (
    <div className={cls}>
      <div className="kpi-card__head">{label}</div>
      <div className="kpi-card__value">{value}</div>
      {sub && <div className="kpi-card__sub">{sub}</div>}
    </div>
  );
}

function formatMoney(value: number): string {
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatRub(value: number): string {
  return `${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} ₽`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU');
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDateOnlyToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateOnlyMonthStart(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}
