import Link from 'next/link';
import { ArrowRight, BadgeRussianRuble, Filter, RotateCcw } from 'lucide-react';
import {
  EMPLOYEE_ROLES,
  type EmployeeRole,
} from '@sewing/shared/employees';
import type {
  PayrollDebtEmployeeRowDto,
  PayrollDebtsPageDto,
} from '@sewing/shared/payroll';
import { ApiRequestError, errorText } from '@/lib/api';
import { getPayrollDebts } from '@/lib/payroll-api';
import { listCompanyDivisions } from '@/lib/company-settings-api';
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
import { formatRole } from '@/lib/admin-labels';

export const dynamic = 'force-dynamic';

interface SearchParams {
  asOfDate?: string;
  employeeId?: string;
  role?: string;
  divisionCode?: string;
  page?: string;
  pageSize?: string;
}

/**
 * Управленческий экран задолженности по сотрудникам (PHASE 3 STEP 7).
 *
 * Показывает актуальный остаток по утверждённым начислениям до выбранной
 * даты. Выплаты CANCELLED не учитываются.
 *
 * Источник данных: `GET /api/payroll/debts`.
 * Формулы: `docs/domain.md §10.7`, `docs/api.md §30b`.
 */
export default async function AdminPayrollDebtsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const today = formatDateOnlyToday();
  const asOfDate = searchParams?.asOfDate?.trim() || today;

  const employeeId = searchParams?.employeeId?.trim() || undefined;
  const role = searchParams?.role?.trim() || undefined;
  const divisionCode = searchParams?.divisionCode?.trim() || undefined;

  const page = Math.max(1, Number(searchParams?.page ?? '1') || 1);
  const pageSize = clampPageSize(Number(searchParams?.pageSize ?? '50'));

  let response: PayrollDebtsPageDto | null = null;
  let error: string | null = null;
  try {
    response = await getPayrollDebts({
      asOfDate,
      employeeId,
      role,
      divisionCode,
      page,
      pageSize,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить отчёт задолженности';
  }

  const [employeesList, divisions] = await Promise.all([
    listEmployees({ active: true }).catch(() => []),
    listCompanyDivisions({ includeInactive: false }).catch(() => []),
  ]);

  const summary = response?.summary;
  const total = response?.total ?? 0;
  const items = response?.items ?? [];

  const preserveParams: Record<string, string | undefined> = {
    asOfDate,
    employeeId,
    role,
    divisionCode,
  };

  return (
    <AdminPageShell
      icon={<BadgeRussianRuble size={22} strokeWidth={1.6} aria-hidden />}
      title="Задолженность по сотрудникам"
      subtitle={`На дату ${formatDate(asOfDate)} · Утверждённые начисления без учёта CANCELLED выплат`}
      actions={
        <>
          <Link href="/admin/payroll/accrual-documents/new" className="admin-btn admin-btn--primary">
            Создать документ начисления
          </Link>
          <Link href="/admin/payroll" className="admin-btn">
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

      <DebtKpiGrid summary={summary} />

      <AdminCard>
        <AdminSectionHeader title="Фильтры" />
        <form method="get" className="admin-form-grid" role="search">
          <div className="admin-field">
            <label htmlFor="debts-as-of-date">На дату</label>
            <input
              id="debts-as-of-date"
              type="date"
              name="asOfDate"
              defaultValue={asOfDate}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="debts-employee">Сотрудник</label>
            <select
              id="debts-employee"
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
            <label htmlFor="debts-role">Роль</label>
            <select id="debts-role" name="role" defaultValue={role ?? ''}>
              <option value="">— любая —</option>
              {EMPLOYEE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {formatRole(r as EmployeeRole)}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="debts-division">Подразделение</label>
            <select
              id="debts-division"
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
              href="/admin/payroll/debts"
              className="admin-btn admin-btn--ghost"
            >
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
        <DebtTable rows={items} asOfDate={asOfDate} />
        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/payroll/debts"
          preserveParams={preserveParams}
          label="сотрудников"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

function DebtKpiGrid({
  summary,
}: {
  summary: PayrollDebtsPageDto['summary'] | undefined;
}) {
  return (
    <div className="kpi-grid">
      <Kpi
        label="Всего начислено"
        value={formatRub(summary?.totalAccruedGrossRub ?? 0)}
        tone="accent"
      />
      <Kpi
        label="Закрыто выплатами"
        value={formatRub(summary?.totalPayoutCoveredRub ?? 0)}
        sub="PIECEWORK · SALARY lines"
        tone="ok"
      />
      <Kpi
        label="Корректировки выплат"
        value={formatRub(summary?.totalPayoutAdjustRub ?? 0)}
        sub="BONUS · DEDUCTION · ADVANCE · ADJUSTMENT"
      />
      <Kpi
        label="Выплачено всего"
        value={formatRub(summary?.totalPaidRub ?? 0)}
        sub="покрытие + корректировки"
      />
      <Kpi
        label="Остаток по начислениям"
        value={formatRub(summary?.totalDebtRub ?? 0)}
        sub={`${summary?.employeesWithDebt ?? 0} сотр. с долгом`}
        tone={(summary?.totalDebtRub ?? 0) > 0 ? 'warn' : undefined}
      />
      <Kpi
        label="Ожидает упаковки"
        value={formatRub(summary?.totalPendingPieceworkRub ?? 0)}
        sub="не включается в остаток"
      />
      <Kpi
        label="Сотрудников с долгом"
        value={String(summary?.employeesWithDebt ?? 0)}
        tone={(summary?.employeesWithDebt ?? 0) > 0 ? 'warn' : undefined}
      />
    </div>
  );
}

function DebtTable({
  rows,
  asOfDate,
}: {
  rows: PayrollDebtEmployeeRowDto[];
  asOfDate: string;
}) {
  const columns: AdminTableColumn<PayrollDebtEmployeeRowDto>[] = [
    {
      key: 'employee',
      header: 'Сотрудник',
      render: (r) => (
        <div className="admin-table__primary">
          {r.fullName}
          <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
            {formatRole(r.role as EmployeeRole)}
            {r.companyDivisionName ? ` · ${r.companyDivisionName}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'piecework',
      header: 'Сдельно начислено, ₽',
      align: 'right',
      render: (r) =>
        r.accruedPieceworkRub > 0 ? (
          formatRub(r.accruedPieceworkRub)
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'salary',
      header: 'Оклад начислен, ₽',
      align: 'right',
      render: (r) =>
        r.accruedSalaryRub > 0 ? (
          formatRub(r.accruedSalaryRub)
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'gross',
      header: 'Начислено всего, ₽',
      align: 'right',
      render: (r) => formatRub(r.accruedGrossRub),
    },
    {
      key: 'covered',
      header: 'Закрыто выплатами, ₽',
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
      key: 'adjust',
      header: 'Корректировки, ₽',
      align: 'right',
      render: (r) =>
        r.payoutAdjustRub !== 0 ? (
          <span>{formatRub(r.payoutAdjustRub)}</span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'paid',
      header: 'Выплачено всего, ₽',
      align: 'right',
      render: (r) =>
        r.paidTotalRub > 0 ? (
          formatRub(r.paidTotalRub)
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'debt',
      header: 'Остаток, ₽',
      align: 'right',
      render: (r) => {
        if (r.debtRub === 0 && r.accruedGrossRub > 0) {
          return (
            <AdminStatusBadge tone="success">закрыто</AdminStatusBadge>
          );
        }
        return r.debtRub > 0 ? (
          <strong style={{ color: 'var(--admin-accent, #1d4ed8)' }}>
            {formatRub(r.debtRub)}
          </strong>
        ) : (
          <span className="admin-muted">—</span>
        );
      },
    },
    {
      key: 'pending',
      header: 'Pending, ₽',
      align: 'right',
      render: (r) =>
        r.pendingPieceworkRub > 0 ? (
          <span style={{ color: 'var(--admin-warning, #b45309)' }}>
            {formatRub(r.pendingPieceworkRub)}
          </span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'lastPayout',
      header: 'Последняя выплата',
      render: (r) =>
        r.lastPayoutAt ? (
          <span className="admin-muted" style={{ fontSize: '0.78rem' }}>
            {formatDateTime(r.lastPayoutAt)}
          </span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      isAction: true,
      render: (r) => (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'nowrap' }}>
          <Link
            href={`/admin/payroll/employees/${r.employeeId}`}
            className="admin-table__action-link"
          >
            Зарплата
            <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
          </Link>
          <Link
            href={`/admin/payroll/accrual-documents/new?asOfDate=${asOfDate}`}
            className="admin-table__action-link"
          >
            Начислить
          </Link>
        </div>
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
          title="Задолженностей нет"
          hint="На выбранную дату по всем сотрудникам начислений нет."
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

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateOnlyToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function clampPageSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 50;
  if (value > 200) return 200;
  return Math.floor(value);
}
