import Link from 'next/link';
import { ArrowLeft, ArrowRight, Clock3 } from 'lucide-react';
import type {
  TimeTrackingRibbonPartDto,
  TimeTrackingSummaryRowDto,
} from '@sewing/shared';
import { categoryClass } from '@/lib/operation-category';
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
 * Общая шкала мини-лент: от начала самого раннего отрезка до конца
 * самого позднего по ВСЕЙ таблице, с получасовым полем по краям.
 * Минимум четыре часа — иначе один короткий заход растянулся бы на всю
 * ширину и читался как полный рабочий день. `null` — лент нет (период
 * больше суток или никто не работал).
 */
function computeRibbonScale(
  rows: TimeTrackingSummaryRowDto[],
): { from: number; span: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    for (const part of r.ribbon) {
      min = Math.min(min, part.startMinute);
      max = Math.max(max, part.startMinute + part.minutes);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const from = Math.max(0, min - 30);
  return { from, span: Math.max(240, max + 30 - from) };
}

/** Подпись часа для шкалы под лентой: минуты от полуночи → «08». */
function hourLabel(minuteOfDay: number): string {
  return String(Math.floor(minuteOfDay / 60) % 24).padStart(2, '0');
}

/**
 * Мини-лента дня: отрезки смен, раскрашенные по участку. Та же палитра,
 * что в кабинете мастера (`--u-*` в globals.css) — экраны обязаны
 * читаться как один инструмент.
 */
function DayRibbon({
  parts,
  scale,
}: {
  parts: TimeTrackingRibbonPartDto[];
  scale: { from: number; span: number };
}) {
  if (parts.length === 0) {
    return <span className={styles.zero}>—</span>;
  }
  return (
    <span className={styles.ribbonBox}>
      <span className={styles.ribbon} aria-hidden>
        {parts.map((p, i) => (
          <i
            key={`${p.startMinute}:${i}`}
            className={categoryClass(p.category)}
            style={{
              left: `${((p.startMinute - scale.from) / scale.span) * 100}%`,
              width: `${Math.max(1, (p.minutes / scale.span) * 100)}%`,
            }}
          />
        ))}
      </span>
      <span className={styles.ribbonScale}>
        <span>{hourLabel(scale.from)}</span>
        <span>{hourLabel(scale.from + scale.span / 2)}</span>
        <span>{hourLabel(scale.from + scale.span)}</span>
      </span>
    </span>
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
  const totalPresence = rows.reduce((s, r) => s + r.presenceMinutes, 0);
  // Загрузка по цеху: сумма отработанного к сумме присутствия. Не среднее
  // из процентов — иначе тот, кто зашёл на 10 минут и всё это время
  // работал, весил бы столько же, сколько отработавший смену.
  const utilization =
    totalPresence > 0 ? Math.round((totalMinutes / totalPresence) * 100) : null;

  // Мини-лента есть только у одних суток; шкала общая для всей таблицы,
  // иначе одинаковая полоска у двух людей означала бы разные часы.
  const ribbonScale = computeRibbonScale(rows);

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
    ...(ribbonScale
      ? [
          {
            key: 'ribbon',
            header: 'День',
            render: (r: TimeTrackingSummaryRowDto) => (
              <DayRibbon parts={r.ribbon} scale={ribbonScale} />
            ),
          } as AdminTableColumn<TimeTrackingSummaryRowDto>,
        ]
      : []),
    {
      key: 'hours',
      header: 'Отработано',
      align: 'right',
      render: (r) =>
        r.totalMinutes > 0 ? (
          <span className={styles.tnum}>
            {fmtDurLabel(r.totalMinutes)}
            {/* Смена, висящая с прошлых суток: «22:40 отработано» — это
                забытое закрытие, а не переработка. */}
            {r.staleShift ? (
              <span className={styles.stale} title="Смена открыта с прошлого дня">
                {' '}
                ⚠
              </span>
            ) : null}
          </span>
        ) : (
          <span className={styles.zero}>—</span>
        ),
    },
    {
      key: 'util',
      header: 'Загрузка',
      align: 'right',
      render: (r) =>
        r.utilization !== null ? (
          <span className={styles.util}>
            <span className={styles.utilBar}>
              <span
                className={styles.utilFill}
                style={{ width: `${Math.min(100, r.utilization)}%` }}
              />
            </span>
            <span className={styles.tnum}>{r.utilization}%</span>
          </span>
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
        <Kpi
          label="Загрузка"
          value={utilization !== null ? `${utilization}%` : '—'}
          foot="в смене / на работе"
        />
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
          rowHref={(r) =>
            `/admin/employees/${r.employeeId}/time-tracker?period=${period}`
          }
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
