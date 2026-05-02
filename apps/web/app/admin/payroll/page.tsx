import Link from 'next/link';
import { ArrowRight, BadgeRussianRuble, Filter, RotateCcw } from 'lucide-react';
import {
  EARNING_STATUSES,
  type EarningStatus,
} from '@sewing/shared/earnings';
import {
  EMPLOYEE_ROLES,
  type EmployeeRole,
} from '@sewing/shared/employees';
import type {
  PayrollPeriodEmployeeRowDto,
  PayrollPeriodPageDto,
} from '@sewing/shared/payroll';
import { ApiRequestError } from '@/lib/api';
import { getPayrollPeriod } from '@/lib/payroll-api';
import { listCompanyDivisions } from '@/lib/company-settings-api';
import { listEmployees } from '@/lib/employees-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminSectionHeader,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { formatCompensation, formatRole } from '@/lib/admin-labels';
import { EARNING_STATUS_LABELS } from '@/lib/earnings-api';

export const dynamic = 'force-dynamic';

interface SearchParams {
  dateFrom?: string;
  dateTo?: string;
  employeeId?: string;
  role?: string;
  divisionCode?: string;
  status?: string;
  page?: string;
  pageSize?: string;
}

/**
 * Управленческая ведомость зарплаты за период (PHASE 1, read-only).
 *
 * Контракт API — `docs/api.md §10c` (`/api/payroll/period`).
 * Доменная модель — `docs/domain.md §10.6`.
 * UX — `docs/screens.md §12a`.
 *
 * Что показываем:
 *   - KPI «всего», «утверждено», «ожидает», «оклад», «сдельно» из
 *     `summary` ответа API;
 *   - таблицу по сотрудникам с разрезом approved/pending и переходом
 *     на drill-down карточку `/admin/payroll/employees/:id`;
 *   - фильтры period / employee / role / divisionCode / status (status
 *     режет только сдельщину; см. `payroll.service.ts`).
 *
 * Никаких мутаций со страницы не делаем — payroll API в PHASE 1
 * сознательно read-only. Если менеджеру нужно поправить начисления,
 * он по-прежнему ходит в `/earnings` (сдельный summary +
 * `SalaryEntryEditor` для окладной части).
 */
export default async function AdminPayrollPeriodPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const today = formatDateOnlyToday();
  const monthStart = formatDateOnlyMonthStart();
  const dateFrom = searchParams?.dateFrom?.trim() || monthStart;
  const dateTo = searchParams?.dateTo?.trim() || today;

  const employeeId = searchParams?.employeeId?.trim() || undefined;
  const role = searchParams?.role?.trim() || undefined;
  const divisionCode = searchParams?.divisionCode?.trim() || undefined;
  const status = parseStatus(searchParams?.status);

  const page = Math.max(1, Number(searchParams?.page ?? '1') || 1);
  const pageSize = clampPageSize(Number(searchParams?.pageSize ?? '50'));

  let response: PayrollPeriodPageDto | null = null;
  let error: string | null = null;
  try {
    response = await getPayrollPeriod({
      dateFrom,
      dateTo,
      employeeId,
      role,
      divisionCode,
      status,
      page,
      pageSize,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить ведомость зарплаты';
  }

  // Параллельно — справочники для фильтров. Если что-то упадёт, не
  // ломаем страницу: фильтр просто схлопнется в пустой select.
  const [employeesList, divisions] = await Promise.all([
    listEmployees({ active: true }).catch(() => []),
    listCompanyDivisions({ includeInactive: false }).catch(() => []),
  ]);

  const summary = response?.summary;
  const total = response?.total ?? 0;
  const items = response?.items ?? [];

  const preserveParams: Record<string, string | undefined> = {
    dateFrom,
    dateTo,
    employeeId,
    role,
    divisionCode,
    status: status ?? undefined,
  };

  return (
    <AdminPageShell
      icon={<BadgeRussianRuble size={22} strokeWidth={1.6} aria-hidden />}
      title="Зарплата"
      subtitle={`Период ${formatDate(dateFrom)} – ${formatDate(dateTo)}`}
      actions={
        <>
          <Link href="/admin/payroll/daily" className="admin-btn">
            День
          </Link>
          <Link href="/admin/payroll/payouts" className="admin-btn">
            Выплаты
          </Link>
          <Link href="/admin/payroll/settings" className="admin-btn admin-btn--ghost">
            Настройки
          </Link>
        </>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <PayrollKpiGrid summary={summary} />

      <AdminCard>
        <AdminSectionHeader title="Фильтры" />
        <form method="get" className="admin-form-grid" role="search">
          <div className="admin-field">
            <label htmlFor="payroll-date-from">С</label>
            <input
              id="payroll-date-from"
              type="date"
              name="dateFrom"
              defaultValue={dateFrom}
              required
            />
          </div>
          <div className="admin-field">
            <label htmlFor="payroll-date-to">По</label>
            <input
              id="payroll-date-to"
              type="date"
              name="dateTo"
              defaultValue={dateTo}
              required
            />
          </div>
          <div className="admin-field">
            <label htmlFor="payroll-employee">Сотрудник</label>
            <select
              id="payroll-employee"
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
            <label htmlFor="payroll-role">Роль</label>
            <select id="payroll-role" name="role" defaultValue={role ?? ''}>
              <option value="">— любая —</option>
              {EMPLOYEE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {formatRole(r as EmployeeRole)}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="payroll-division">Подразделение</label>
            <select
              id="payroll-division"
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
          <div className="admin-field">
            <label htmlFor="payroll-status">Статус сдельщины</label>
            <select
              id="payroll-status"
              name="status"
              defaultValue={status ?? ''}
            >
              <option value="">— любой —</option>
              {EARNING_STATUSES.filter((s) => s !== 'REVERSED').map((s) => (
                <option key={s} value={s}>
                  {EARNING_STATUS_LABELS[s]}
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
            <Link href="/admin/payroll" className="admin-btn admin-btn--ghost">
              <RotateCcw size={14} strokeWidth={1.6} aria-hidden />
              Сбросить
            </Link>
          </div>
        </form>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader
          title="По сотрудникам"
          hint={`${total} сотр.`}
        />
        <PayrollPeriodTable rows={items} />
        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/payroll"
          preserveParams={preserveParams}
          label="сотрудников"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

function PayrollKpiGrid({
  summary,
}: {
  summary: PayrollPeriodPageDto['summary'] | undefined;
}) {
  return (
    <div className="kpi-grid">
      <Kpi
        label="Всего начислено"
        value={formatRub(summary?.totalRub ?? 0)}
        sub={`${summary?.employeesCount ?? 0} сотр.`}
        tone="accent"
      />
      <Kpi
        label="Утверждено"
        value={formatRub(summary?.totalApprovedRub ?? 0)}
        sub={`${(summary?.pieceworkEntriesCount ?? 0) - (summary?.pieceworkPendingCount ?? 0)} сделок · ${summary?.salaryEntriesCount ?? 0} дней оклада`}
        tone="ok"
      />
      <Kpi
        label="Ожидает упаковки"
        value={formatRub(summary?.totalPendingRub ?? 0)}
        sub={`${summary?.pieceworkPendingCount ?? 0} строк`}
        tone="warn"
      />
      <Kpi
        label="Выплачено / в выплатах"
        value={formatRub(summary?.totalPayoutCoveredRub ?? 0)}
        sub="DRAFT · ISSUED · ACKNOWLEDGED"
      />
      <Kpi
        label="К выплате сейчас"
        value={formatRub(summary?.totalNetToPayRub ?? 0)}
        sub={`${summary?.employeesCount ?? 0} сотр.`}
        tone={(summary?.totalNetToPayRub ?? 0) > 0 ? 'accent' : undefined}
      />
      <Kpi
        label="Оклад"
        value={formatRub(summary?.salaryRub ?? 0)}
        sub={
          summary && summary.salaryEditedRub > 0
            ? `${summary.salaryEntriesCount} дней · ${summary.salaryEditedCount} с правкой`
            : `${summary?.salaryEntriesCount ?? 0} дней`
        }
      />
      <Kpi
        label="Сдельно"
        value={formatRub(summary?.pieceworkRub ?? 0)}
        sub={`${summary?.pieceworkEntriesCount ?? 0} строк`}
      />
    </div>
  );
}

function PayrollPeriodTable({ rows }: { rows: PayrollPeriodEmployeeRowDto[] }) {
  const columns: AdminTableColumn<PayrollPeriodEmployeeRowDto>[] = [
    {
      key: 'employee',
      header: 'Сотрудник',
      render: (r) => (
        <div className="admin-table__primary">
          {r.fullName}
          <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
            {formatRole(r.role)} · {formatCompensation(r.compensationType)}
            {r.companyDivision ? ` · ${r.companyDivision}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'days',
      header: 'Дней',
      align: 'right',
      render: (r) => (r.daysOnShift > 0 ? r.daysOnShift : '—'),
    },
    {
      key: 'salary',
      header: 'Оклад, ₽',
      align: 'right',
      render: (r) =>
        r.salaryRub > 0 ? (
          <span>
            {formatRub(r.salaryRub)}
            {r.salaryEditedRub > 0 && (
              <div className="admin-muted" style={{ fontSize: '0.72rem' }}>
                из них правка: {formatRub(r.salaryEditedRub)}
              </div>
            )}
          </span>
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
      key: 'accrued',
      header: 'Начислено, ₽',
      align: 'right',
      render: (r) => formatRub(r.grossAccruedRub),
    },
    {
      key: 'inPayouts',
      header: 'Уже в выплатах, ₽',
      align: 'right',
      render: (r) =>
        r.payoutCoveredRub > 0 ? (
          <span style={{ color: 'var(--admin-muted-fg, #6b7280)' }}>
            {formatRub(r.payoutCoveredRub)}
          </span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'netToPay',
      header: 'К выплате сейчас, ₽',
      align: 'right',
      render: (r) => {
        if (r.netToPayRub === 0 && r.grossAccruedRub > 0) {
          return (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                color: 'var(--admin-ok, #16a34a)',
                fontSize: '0.78rem',
                fontWeight: 600,
              }}
            >
              выплачено/закрыто
            </span>
          );
        }
        return r.netToPayRub > 0 ? (
          <strong style={{ color: 'var(--admin-accent, #1d4ed8)' }}>
            {formatRub(r.netToPayRub)}
          </strong>
        ) : (
          <span className="admin-muted">—</span>
        );
      },
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
          icon={<BadgeRussianRuble size={26} strokeWidth={1.6} aria-hidden />}
          title="За период начислений нет"
        />
      }
    />
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
  return d.toLocaleDateString('ru-RU');
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

function parseStatus(value: string | undefined): EarningStatus | undefined {
  if (!value) return undefined;
  return (EARNING_STATUSES as readonly string[]).includes(value)
    ? (value as EarningStatus)
    : undefined;
}

function clampPageSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 50;
  if (value > 200) return 200;
  return Math.floor(value);
}
