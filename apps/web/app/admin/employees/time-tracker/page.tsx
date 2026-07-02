import Link from 'next/link';
import { ArrowLeft, ArrowRight, Clock3 } from 'lucide-react';
import type { TimeTrackingSummaryRowDto } from '@sewing/shared';
import { ApiRequestError, errorText } from '@/lib/api';
import { getEmployeesTimeTrackingSummary } from '@/lib/time-tracking-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { formatRole } from '@/lib/admin-labels';
import {
  computeRange,
  fmtDateTime,
  fmtDurLabel,
  fmtRangeLabel,
  normalizeAnchor,
  normalizePeriod,
  ru,
  type TtPeriod,
} from '@/lib/time-tracker-period';
import styles from './overview.module.css';

export const dynamic = 'force-dynamic';

const PERIODS: Array<{ key: TtPeriod; label: string }> = [
  { key: 'day', label: 'День' },
  { key: 'week', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
];

function Kpi({
  label,
  value,
  unit,
  foot,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  foot?: string;
  tone?: 'live' | 'warn';
}) {
  const cls = [
    styles.kpi,
    tone === 'live' ? styles.kpiLive : '',
    tone === 'warn' ? styles.kpiWarn : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls}>
      <div className={styles.kpiLbl}>{label}</div>
      <div className={styles.kpiVal}>
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {foot ? <div className={styles.kpiFoot}>{foot}</div> : null}
    </div>
  );
}

/**
 * «Тайм-трекер» — обзор всех сотрудников (вкладка «Сотрудники»,
 * список-уровень). Таблица: строка = сотрудник + часы/сеансы/выработка/
 * брак за период + «на смене сейчас». Провал в строку → таймлайн сеансов
 * одного сотрудника (`/admin/employees/[id]/time-tracker`).
 */
export default async function EmployeesTimeTrackerOverviewPage({
  searchParams,
}: {
  searchParams: { period?: string; date?: string };
}) {
  const period = normalizePeriod(searchParams.period);
  const anchor = normalizeAnchor(searchParams.date);
  const { from, to } = computeRange(period, anchor);

  let rows: TimeTrackingSummaryRowDto[] = [];
  let error: string | null = null;
  try {
    const data = await getEmployeesTimeTrackingSummary({ from, to });
    rows = data.rows;
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить тайм-трекер';
  }

  const basePath = '/admin/employees/time-tracker';
  const onShiftNow = rows.filter((r) => r.onShift).length;
  const totalMinutes = rows.reduce((s, r) => s + r.totalMinutes, 0);
  const totalOps = rows.reduce((s, r) => s + r.operationsCount, 0);
  const totalQty = rows.reduce((s, r) => s + r.qtyGood, 0);
  const totalDefects = rows.reduce((s, r) => s + r.defects, 0);

  const columns: AdminTableColumn<TimeTrackingSummaryRowDto>[] = [
    {
      key: 'name',
      header: 'Сотрудник',
      render: (r) => (
        <span className={styles.who}>
          <span className={r.onShift ? styles.dotLive : styles.dotOff} />
          <span className="admin-table__primary">{r.employeeName}</span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Роль',
      render: (r) => formatRole(r.role),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (r) =>
        r.onShift ? (
          <span className={`${styles.badge} ${styles.badgeOn}`}>
            На смене
            {r.currentEquipmentCode ? (
              <span className={styles.k}>{r.currentEquipmentCode}</span>
            ) : null}
          </span>
        ) : (
          <span className={`${styles.badge} ${styles.badgeOff}`}>
            Не на смене
          </span>
        ),
    },
    {
      key: 'hours',
      header: 'Отработано',
      align: 'right',
      render: (r) =>
        r.totalMinutes > 0 ? (
          <span className={styles.tnum}>{fmtDurLabel(r.totalMinutes)}</span>
        ) : (
          <span className={styles.zero}>—</span>
        ),
    },
    {
      key: 'sessions',
      header: 'Сеансов',
      align: 'right',
      render: (r) =>
        r.sessionsCount > 0 ? (
          <span className={styles.tnum}>{ru(r.sessionsCount)}</span>
        ) : (
          <span className={styles.zero}>—</span>
        ),
    },
    {
      key: 'ops',
      header: 'Операций',
      align: 'right',
      render: (r) =>
        r.operationsCount > 0 ? (
          <span className={styles.tnum}>{ru(r.operationsCount)}</span>
        ) : (
          <span className={styles.zero}>—</span>
        ),
    },
    {
      key: 'qty',
      header: 'Выработка',
      align: 'right',
      render: (r) =>
        r.qtyGood > 0 ? (
          <span className={styles.tnum}>
            {ru(r.qtyGood)}
            {r.perHour > 0 ? (
              <span className={styles.muted}> · {ru(r.perHour)}/ч</span>
            ) : null}
          </span>
        ) : (
          <span className={styles.zero}>—</span>
        ),
    },
    {
      key: 'defects',
      header: 'Брак',
      align: 'right',
      render: (r) =>
        r.defects > 0 ? (
          <span className={`${styles.tnum} ${styles.bad}`}>{ru(r.defects)}</span>
        ) : (
          <span className={styles.zero}>0</span>
        ),
    },
    {
      key: 'last',
      header: 'Активность',
      render: (r) =>
        r.lastActivityAt ? (
          <span className={`${styles.tnum} ${styles.muted}`}>
            {fmtDateTime(r.lastActivityAt)}
          </span>
        ) : (
          <span className={styles.zero}>—</span>
        ),
    },
    {
      key: 'drill',
      header: '',
      isAction: true,
      render: (r) => (
        <Link
          href={`/admin/employees/${r.employeeId}/time-tracker?period=${period}`}
          className={styles.drill}
        >
          Таймлайн
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      ),
    },
  ];

  return (
    <AdminPageShell
      icon={<Clock3 size={22} strokeWidth={1.6} aria-hidden />}
      title="Тайм-трекер"
      subtitle="Сотрудники · сеансы, часы и выработка за период"
      actions={
        <Link href="/admin/employees" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {/* период */}
      <div className={styles.periodBar}>
        <div className={styles.seg} role="group" aria-label="Период">
          {PERIODS.map((p) => (
            <Link
              key={p.key}
              href={`${basePath}?period=${p.key}`}
              className={`${styles.segItem} ${
                period === p.key ? styles.segOn : ''
              }`}
            >
              {p.label}
            </Link>
          ))}
        </div>
        <div className={styles.rangeLabel}>
          <strong>{fmtRangeLabel(period, from, to)}</strong>
        </div>
      </div>

      {/* сводка по всем */}
      <div className={styles.kpis}>
        <Kpi
          label="На смене сейчас"
          value={ru(onShiftNow)}
          tone={onShiftNow > 0 ? 'live' : undefined}
          foot={`из ${ru(rows.length)} сотрудников`}
        />
        <Kpi label="Отработано" value={fmtDurLabel(totalMinutes)} foot="суммарно" />
        <Kpi label="Операций" value={ru(totalOps)} foot="завершено" />
        <Kpi label="Выработка" value={ru(totalQty)} unit="шт" />
        <Kpi
          label="Брак"
          value={ru(totalDefects)}
          unit="шт"
          tone={totalDefects > 0 ? 'warn' : undefined}
        />
      </div>

      <AdminCard>
        <AdminSectionHeader
          title="Сотрудники"
          hint={`${rows.length}`}
        />
        <AdminTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.employeeId}
          emptyContent={
            <AdminEmptyState
              icon={<Clock3 size={26} strokeWidth={1.6} aria-hidden />}
              title="Нет данных за период"
            />
          }
        />
      </AdminCard>

      <div className={styles.note}>
        <span>
          Сеанс = смена (скан рабочего стола). Часы считаются по сеансам
          (открытый — до текущего момента), выработка и брак — по завершениям
          операций (как в «Статистике по сотрудникам»). Нажмите{' '}
          <b>«Таймлайн»</b>, чтобы раскрыть сеансы одного сотрудника.
        </span>
      </div>
    </AdminPageShell>
  );
}
