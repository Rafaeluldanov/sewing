import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  EARNING_STATUSES,
  type EarningStatus,
} from '@sewing/shared/earnings';
import type { SalaryEntryDto } from '@sewing/shared/salary';
import {
  EARNING_STATUS_LABELS,
  getEarningsSummary,
  listEarnings,
} from '@/lib/earnings-api';
import { getSalarySummary, listSalary } from '@/lib/salary-api';
import { getShiftMeta } from '@/lib/shifts-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { Icon, type IconName } from '@/components/icon';
import { SalaryEntryEditor } from './salary-entry-editor';

export const dynamic = 'force-dynamic';

interface SearchParams {
  employeeId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: string;
}

/**
 * Роли с полной видимостью начислений (см. `apps/api/.../earnings.constants.ts`,
 * `EARNINGS_MANAGER_ROLES`). Для всех остальных ролей экран показывает
 * «Мои начисления» — backend в любом случае режет ответы по `employeeId`
 * текущей сессии и только `APPROVED` (см. `docs/api.md §10`).
 */
function isEarningsManager(role: string): boolean {
  return role === 'SHOP_MANAGER' || role === 'ADMIN';
}

function parseStatus(value: string | undefined): EarningStatus | undefined {
  if (!value) return undefined;
  return (EARNING_STATUSES as readonly string[]).includes(value)
    ? (value as EarningStatus)
    : undefined;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU');
}

function formatMoney(value: number): string {
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default async function EarningsListPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/earnings');
  const isManager = isEarningsManager(me.user.role);

  // Не-менеджер не должен даже визуально знать, что в системе бывают
  // чужие начисления или не-APPROVED строки. Поэтому query-параметры
  // employeeId/status у него игнорируются ещё до запроса в API
  // (бэкенд всё равно их затрёт — это страховка для UI-ссылок и
  // пагинации).
  const employeeId = isManager
    ? (searchParams.employeeId ?? '').trim() || undefined
    : undefined;
  const status: EarningStatus | undefined = isManager
    ? parseStatus(searchParams.status)
    : 'APPROVED';
  const dateFrom = (searchParams.dateFrom ?? '').trim() || undefined;
  const dateTo = (searchParams.dateTo ?? '').trim() || undefined;
  const page = Math.max(1, Number(searchParams.page ?? '1') || 1);
  const pageSize = 50;

  // Окладные начисления (ADR-0021): подтягиваем параллельно вместе со
  // сдельными. fail-soft, чтобы старые БД без миграции `SalaryEntry` не
  // ломали экран — но в обычном пайплайне ошибки тут означают баг и
  // должны быть видны разработчику в логах SSR.
  const [meta, list, summary, salaryList, salarySummary] = await Promise.all([
    isManager ? getShiftMeta() : Promise.resolve(null),
    listEarnings({
      employeeId,
      status,
      dateFrom,
      dateTo,
      page,
      pageSize,
    }),
    getEarningsSummary({
      employeeId,
      dateFrom,
      dateTo,
    }),
    listSalary({
      employeeId,
      dateFrom,
      dateTo,
      page: 1,
      pageSize: 100,
    }).catch(() => ({ items: [] as SalaryEntryDto[], total: 0, page: 1, pageSize: 100 })),
    getSalarySummary({ employeeId, dateFrom, dateTo }).catch(() => ({
      total: 0,
      totalEditedManually: 0,
      count: 0,
      countEditedManually: 0,
    })),
  ]);

  const total = summary.totalApproved + summary.totalPending + salarySummary.total;
  const hasFilters = isManager
    ? Boolean(employeeId || status || dateFrom || dateTo)
    : Boolean(dateFrom || dateTo);
  const totalPages = Math.max(1, Math.ceil(list.total / pageSize));

  return (
    <div className="page-shell">
      <div>
        <div className="page-eyebrow">
          <Icon name="earnings" />
          {isManager ? 'Зарплата и начисления' : 'Мои выплаты'}
        </div>
        <h1 className="page-title">
          <Icon name="earnings" />
          {isManager ? 'Начисления' : 'Мои начисления'}
        </h1>
        <p className="page-subtitle">
          {isManager
            ? 'Шаг 9 MVP: сдельная зарплата раскройщика и пошива. Раскройщик подтверждается сразу при выпуске паспорта, пошив — после упаковки. Окладные роли (ОТК, помощник раскройщика, упаковщики, ВТО) сюда не попадают (см. ADR-0005).'
            : 'Здесь видны только ваши подтверждённые начисления. Сдельная зарплата раскройщика подтверждается сразу при выпуске паспорта, пошива — после упаковки коробки.'}
        </p>
        {isManager && (
          <p className="meta-line" style={{ marginTop: '0.5rem' }}>
            Полный payroll-отчёт по сотрудникам — в{' '}
            <Link href="/admin/payroll">«Зарплата»</Link> (PHASE 1,
            read-only ведомость по периоду / дню / сотруднику).
          </p>
        )}
      </div>

      <div className="kpi-grid">
        <SummaryKpi
          icon="earnings"
          tone="ok"
          label="Сдельная (подтверждено)"
          value={`${formatMoney(summary.totalApproved)} ₽`}
          sub={`${summary.countApproved} начислений`}
        />
        <SummaryKpi
          icon="employees"
          tone="ok"
          label="Оклад за смены"
          value={`${formatMoney(salarySummary.total)} ₽`}
          sub={
            `${salarySummary.count} дн.` +
            (salarySummary.countEditedManually > 0
              ? ` · ${salarySummary.countEditedManually} с правкой`
              : '')
          }
        />
        {isManager && (
          <>
            <SummaryKpi
              icon="idle"
              tone="warn"
              label="Ожидает выпуск"
              value={`${formatMoney(summary.totalPending)} ₽`}
              sub={`${summary.countPending} начислений`}
            />
            <SummaryKpi
              icon="output"
              tone="accent"
              label="Всего"
              value={`${formatMoney(total)} ₽`}
              sub={`${summary.countApproved + summary.countPending + salarySummary.count} строк`}
            />
          </>
        )}
      </div>

      <form method="get" className="card" style={{ marginBottom: '1rem' }}>
        {isManager && meta && (
          <>
            <div className="form-row">
              <label htmlFor="employeeId">Сотрудник</label>
              <select
                id="employeeId"
                name="employeeId"
                defaultValue={employeeId ?? ''}
              >
                <option value="">— все —</option>
                {meta.employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName} ({e.login})
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label htmlFor="status">Статус</label>
              <select id="status" name="status" defaultValue={status ?? ''}>
                <option value="">— любой —</option>
                {EARNING_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {EARNING_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <div className="form-row">
          <label htmlFor="dateFrom">Период</label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              id="dateFrom"
              name="dateFrom"
              type="date"
              defaultValue={dateFrom ?? ''}
            />
            <input
              id="dateTo"
              name="dateTo"
              type="date"
              defaultValue={dateTo ?? ''}
            />
          </div>
        </div>
        <div className="actions-row">
          <button type="submit" className="btn btn-primary">
            <Icon name="filter" size={14} />
            <span style={{ marginLeft: '0.35rem' }}>Применить</span>
          </button>
          {hasFilters && (
            <Link className="btn btn-ghost" href="/earnings">
              <Icon name="reset" size={14} />
              <span style={{ marginLeft: '0.35rem' }}>Сбросить</span>
            </Link>
          )}
        </div>
      </form>

      <div className="meta-line" style={{ margin: '0 0 0.75rem' }}>
        Показано {list.items.length} из {list.total}
        {totalPages > 1 ? ` · стр. ${page} из ${totalPages}` : ''}
      </div>

      {list.items.length === 0 ? (
        <div className="card empty">
          {hasFilters
            ? 'По заданным фильтрам начислений нет.'
            : isManager
              ? 'Пока нет ни одного начисления. Они появятся после выпуска паспортов и сканирования на операциях.'
              : 'У вас пока нет подтверждённых начислений. Они появятся после выпуска паспортов и упаковки.'}
        </div>
      ) : (
        <div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Дата</th>
                {isManager && <th>Сотрудник</th>}
                <th>Операция</th>
                <th>Паспорт</th>
                <th>Размер</th>
                <th style={{ textAlign: 'right' }}>Кол-во</th>
                <th style={{ textAlign: 'right' }}>Ставка, ₽</th>
                <th style={{ textAlign: 'right' }}>Сумма, ₽</th>
                {isManager && <th>Статус</th>}
              </tr>
            </thead>
            <tbody>
              {list.items.map((e) => (
                <tr key={e.id}>
                  <td>
                    {formatDateTime(e.createdAt)}
                    {e.approvedAt && e.approvedAt !== e.createdAt && (
                      <div className="meta-line">
                        ✓ {formatDateTime(e.approvedAt)}
                      </div>
                    )}
                  </td>
                  {isManager && <td>{e.employeeFullName}</td>}
                  <td>
                    {e.operationName}
                    <div className="meta-line">
                      <code>{e.operationCode}</code>
                    </div>
                  </td>
                  <td>
                    <Link href={`/passports/${e.passportId}`}>
                      {e.passportNumber}
                    </Link>
                    <div className="meta-line">{e.orderNumber}</div>
                  </td>
                  <td>{e.sizeCode}</td>
                  <td style={{ textAlign: 'right' }}>{e.qty}</td>
                  <td style={{ textAlign: 'right' }}>
                    {formatMoney(e.ratePerUnit)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <strong>{formatMoney(e.amount)}</strong>
                  </td>
                  {isManager && (
                    <td>
                      <span className={`status-badge ${earningStatusClass(e.status)}`}>
                        {EARNING_STATUS_LABELS[e.status]}
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="actions-row" style={{ marginTop: '1rem' }}>
              {page > 1 && (
                <Link
                  className="btn"
                  href={buildPageHref(searchParams, page - 1, isManager)}
                >
                  ← Назад
                </Link>
              )}
              {page < totalPages && (
                <Link
                  className="btn"
                  href={buildPageHref(searchParams, page + 1, isManager)}
                >
                  Вперёд →
                </Link>
              )}
            </div>
          )}
        </div>
      )}

      <h2 style={{ marginTop: '2rem' }}>Окладные начисления</h2>
      <p className="meta-line" style={{ marginTop: 0 }}>
        Запись создаётся автоматически за каждый день, в который у
        сотрудника с типом «Оклад» или «Смешанная» была хотя бы одна
        смена (см. ADR-0021). Длительность смены и закрытие не учитываются.
        {isManager
          ? ' Менеджер может вручную поправить сумму или комментарий — флаг «исправлено вручную» защищает запись от автоматики.'
          : ' Здесь видны только ваши окладные начисления.'}
      </p>

      {salaryList.items.length === 0 ? (
        <div className="card empty">
          {hasFilters
            ? 'По заданным фильтрам окладных начислений нет.'
            : 'Пока нет ни одной окладной записи. Они появятся, когда сотрудник на окладе откроет смену.'}
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Дата</th>
              {isManager && <th>Сотрудник</th>}
              <th>Источник</th>
              <th style={{ textAlign: 'right' }}>Сумма, ₽</th>
              <th>Комментарий</th>
              {isManager && <th></th>}
            </tr>
          </thead>
          <tbody>
            {salaryList.items.map((s) => (
              <tr key={s.id}>
                <td>{formatDateOnly(s.date)}</td>
                {isManager && <td>{s.employeeFullName}</td>}
                <td>
                  {s.source === 'SHIFT_DAY' ? 'Оклад за смену' : 'Ручное'}
                  {s.editedManually && (
                    <div className="meta-line">
                      исправлено вручную
                      {s.editedByFullName ? ` · ${s.editedByFullName}` : ''}
                    </div>
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{formatMoney(s.amount)}</strong>
                </td>
                <td>
                  {s.managerComment ? (
                    s.managerComment
                  ) : (
                    <span className="meta-line">—</span>
                  )}
                </td>
                {isManager && (
                  <td>
                    <SalaryEntryEditor entry={s} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatDateOnly(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}

function earningStatusClass(status: EarningStatus): string {
  switch (status) {
    case 'APPROVED':
      return 'packed';
    case 'PENDING_RELEASE':
      return 'in_progress';
    case 'REVERSED':
      return 'cancelled';
    default:
      return 'created';
  }
}

type KpiTone = 'ok' | 'warn' | 'danger' | 'accent';
function SummaryKpi({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: IconName;
  label: string;
  value: string;
  sub?: string;
  tone?: KpiTone;
}) {
  const cls = `kpi-card${tone ? ` kpi-card--${tone}` : ''}`;
  return (
    <div className={cls}>
      <div className="kpi-card__head">
        <span className="kpi-card__icon">
          <Icon name={icon} />
        </span>
        {label}
      </div>
      <div className="kpi-card__value">{value}</div>
      {sub && <div className="kpi-card__sub">{sub}</div>}
    </div>
  );
}

function buildPageHref(
  params: SearchParams,
  page: number,
  isManager: boolean,
): string {
  const sp = new URLSearchParams();
  if (isManager && params.employeeId) sp.set('employeeId', params.employeeId);
  if (isManager && params.status) sp.set('status', params.status);
  if (params.dateFrom) sp.set('dateFrom', params.dateFrom);
  if (params.dateTo) sp.set('dateTo', params.dateTo);
  sp.set('page', String(page));
  return `/earnings?${sp.toString()}`;
}
