import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Filter,
  RotateCcw,
} from 'lucide-react';
import {
  EMPLOYEE_ROLES,
  type EmployeeRole,
} from '@sewing/shared/employees';
import type {
  PayrollDailyEmployeeRowDto,
  PayrollDailyPageDto,
} from '@sewing/shared/payroll';
import { ApiRequestError } from '@/lib/api';
import { getPayrollDaily } from '@/lib/payroll-api';
import { listCompanyDivisions } from '@/lib/company-settings-api';
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

export const dynamic = 'force-dynamic';

interface SearchParams {
  date?: string;
  role?: string;
  divisionCode?: string;
}

/**
 * Дневной снимок зарплаты `/admin/payroll/daily` (PHASE 1, read-only).
 *
 * Контракт API — `docs/api.md §10c` (`/api/payroll/daily`).
 * UX — `docs/screens.md §12a`.
 *
 * Что показываем:
 *   - один календарный день: кто открывал смену, кто получил оклад,
 *     кто получил сдельщину;
 *   - флаг «была смена», `shiftStartedAt` / `shiftStoppedAt`
 *     (последний — null, если хоть одна смена не закрыта);
 *   - сдельщина approved / pending за день и оклад за день.
 *
 * Никаких мутаций — payroll API в PHASE 1 read-only. Открывать /
 * закрывать смены и править оклад менеджер по-прежнему может в
 * `/admin/employees` и `/earnings` (см. ADR-0021).
 */
export default async function AdminPayrollDailyPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const today = formatDateOnlyToday();
  const date = searchParams?.date?.trim() || today;
  const role = searchParams?.role?.trim() || undefined;
  const divisionCode = searchParams?.divisionCode?.trim() || undefined;

  let response: PayrollDailyPageDto | null = null;
  let error: string | null = null;
  try {
    response = await getPayrollDaily({ date, role, divisionCode });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить дневной отчёт';
  }

  const divisions = await listCompanyDivisions({ includeInactive: false }).catch(
    () => [],
  );

  const summary = response?.summary;
  const rows = response?.employees ?? [];

  return (
    <AdminPageShell
      icon={<CalendarDays size={22} strokeWidth={1.6} aria-hidden />}
      title="Зарплата за день"
      subtitle={formatDate(date)}
      actions={
        <Link href="/admin/payroll" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К ведомости
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <div className="kpi-grid">
        <Kpi
          label="Сотрудники"
          value={String(summary?.employeesCount ?? 0)}
          sub={`Смен: ${summary?.shiftsCount ?? 0}`}
          tone="accent"
        />
        <Kpi
          label="Оклад"
          value={formatRub(summary?.salaryRub ?? 0)}
          sub="Σ за день"
        />
        <Kpi
          label="Сдельно (утв.)"
          value={formatRub(summary?.pieceworkApprovedRub ?? 0)}
          tone="ok"
        />
        <Kpi
          label="Сдельно (ожидает)"
          value={formatRub(summary?.pieceworkPendingRub ?? 0)}
          tone="warn"
        />
        <Kpi
          label="Всего за день"
          value={formatRub(summary?.totalRub ?? 0)}
          tone="accent"
        />
      </div>

      <AdminCard>
        <AdminSectionHeader title="Фильтры" />
        <form method="get" className="admin-form-grid" role="search">
          <div className="admin-field">
            <label htmlFor="payroll-daily-date">Дата</label>
            <input
              id="payroll-daily-date"
              type="date"
              name="date"
              defaultValue={date}
              required
            />
          </div>
          <div className="admin-field">
            <label htmlFor="payroll-daily-role">Роль</label>
            <select
              id="payroll-daily-role"
              name="role"
              defaultValue={role ?? ''}
            >
              <option value="">— любая —</option>
              {EMPLOYEE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {formatRole(r as EmployeeRole)}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="payroll-daily-division">Подразделение</label>
            <select
              id="payroll-daily-division"
              name="divisionCode"
              defaultValue={divisionCode ?? ''}
            >
              <option value="">— все —</option>
              {divisions.map((d) => (
                <option key={d.id} value={d.code}>
                  {d.name}
                </option>
              ))}
            </select>
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
              href="/admin/payroll/daily"
              className="admin-btn admin-btn--ghost"
            >
              <RotateCcw size={14} strokeWidth={1.6} aria-hidden />
              Сегодня
            </Link>
          </div>
        </form>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader
          title="Сотрудники за день"
          hint={`${rows.length}`}
        />
        <PayrollDailyTable rows={rows} />
      </AdminCard>
    </AdminPageShell>
  );
}

function PayrollDailyTable({ rows }: { rows: PayrollDailyEmployeeRowDto[] }) {
  const columns: AdminTableColumn<PayrollDailyEmployeeRowDto>[] = [
    {
      key: 'employee',
      header: 'Сотрудник',
      render: (r) => (
        <div className="admin-table__primary">
          {r.fullName}
          <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
            {formatRole(r.role)} · {formatCompensation(r.compensationType)}
          </div>
        </div>
      ),
    },
    {
      key: 'shift',
      header: 'Смена',
      render: (r) =>
        r.hadShift ? (
          <ShiftBadge
            startedAt={r.shiftStartedAt}
            stoppedAt={r.shiftStoppedAt}
          />
        ) : (
          <span className="admin-muted">не было</span>
        ),
    },
    {
      key: 'salary',
      header: 'Оклад, ₽',
      align: 'right',
      render: (r) =>
        r.salaryRub > 0 ? (
          formatRub(r.salaryRub)
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'piecework',
      header: 'Сдельно (утв.), ₽',
      align: 'right',
      render: (r) =>
        r.pieceworkApprovedRub > 0 ? (
          formatRub(r.pieceworkApprovedRub)
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'pending',
      header: 'Ожидает, ₽',
      align: 'right',
      render: (r) =>
        r.pieceworkPendingRub > 0 ? (
          <span style={{ color: 'var(--admin-warning, #b45309)' }}>
            {formatRub(r.pieceworkPendingRub)}
          </span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'total',
      header: 'Итого, ₽',
      align: 'right',
      render: (r) => <strong>{formatRub(r.totalRub)}</strong>,
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (r) => (
        <Link
          href={`/admin/payroll/employees/${r.employeeId}`}
          className="admin-table__action-link"
        >
          Открыть
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      ),
    },
  ];
  return (
    <AdminTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.employeeId}
      emptyContent={
        <AdminEmptyState
          icon={<CalendarDays size={26} strokeWidth={1.6} aria-hidden />}
          title="В этот день никто не работал"
        />
      }
    />
  );
}

function ShiftBadge({
  startedAt,
  stoppedAt,
}: {
  startedAt: string | null;
  stoppedAt: string | null;
}) {
  const start = startedAt ? formatTime(startedAt) : '—';
  const stop = stoppedAt ? formatTime(stoppedAt) : '…';
  if (startedAt && !stoppedAt) {
    return (
      <span>
        <AdminStatusBadge tone="info">Открыта</AdminStatusBadge>
        <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
          с {start}
        </div>
      </span>
    );
  }
  return (
    <span>
      <AdminStatusBadge tone="success">Закрыта</AdminStatusBadge>
      <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
        {start} – {stop}
      </div>
    </span>
  );
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

function formatRub(value: number): string {
  return `${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} ₽`;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
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
