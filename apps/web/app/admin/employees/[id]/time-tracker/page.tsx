import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ChevronRight, Clock3, Info } from 'lucide-react';
import type {
  TimeTrackingDto,
  TimeTrackingEventDto,
  TimeTrackingSessionDto,
} from '@sewing/shared';
import { ApiRequestError } from '@/lib/api';
import { getEmployeeTimeTracking } from '@/lib/time-tracking-api';
import { AdminPageShell } from '@/components/admin';
import { formatRole } from '@/lib/admin-labels';
import styles from './time-tracker.module.css';

export const dynamic = 'force-dynamic';

type Period = 'day' | 'week' | 'month';

const MSK = 'Europe/Moscow';
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Даты (московский день; см. допущение в time-tracking.ts — на дневных
// сменах цеха московский день совпадает с UTC-днём окна на бэке).
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Сегодняшний московский день как `YYYY-MM-DD`. */
function moscowToday(): string {
  const msk = new Date(Date.now() + MSK_OFFSET_MS);
  return `${msk.getUTCFullYear()}-${pad2(msk.getUTCMonth() + 1)}-${pad2(
    msk.getUTCDate(),
  )}`;
}

/** Полдень UTC выбранного дня — безопасный «якорь» для арифметики дат. */
function noon(dayStr: string): Date {
  return new Date(`${dayStr}T12:00:00.000Z`);
}

function addDays(dayStr: string, delta: number): string {
  const d = noon(dayStr);
  d.setUTCDate(d.getUTCDate() + delta);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(
    d.getUTCDate(),
  )}`;
}

/** Вычисляет диапазон `[from; to]` под выбранный период и якорный день. */
function computeRange(period: Period, anchor: string): { from: string; to: string } {
  if (period === 'day') return { from: anchor, to: anchor };
  if (period === 'week') {
    const wd = noon(anchor).getUTCDay(); // 0=вс..6=сб
    const backToMonday = (wd + 6) % 7;
    const from = addDays(anchor, -backToMonday);
    return { from, to: addDays(from, 6) };
  }
  // month
  const a = noon(anchor);
  const y = a.getUTCFullYear();
  const m = a.getUTCMonth();
  const from = `${y}-${pad2(m + 1)}-01`;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { from, to: `${y}-${pad2(m + 1)}-${pad2(lastDay)}` };
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  // страховка от бесконечного цикла
  for (let i = 0; i < 400 && cur <= to; i += 1) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Форматирование
// ---------------------------------------------------------------------------

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', {
    timeZone: MSK,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtHM(totalMinutes: number): { h: number; m: number } {
  return { h: Math.floor(totalMinutes / 60), m: totalMinutes % 60 };
}

function fmtDurLabel(totalMinutes: number): string {
  const { h, m } = fmtHM(totalMinutes);
  if (h > 0) return `${h} ч ${pad2(m)} м`;
  return `${m} м`;
}

function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function fmtDayTitle(dayStr: string): string {
  return cap(
    noon(dayStr).toLocaleDateString('ru-RU', {
      timeZone: MSK,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }),
  );
}

function fmtShort(dayStr: string): string {
  return noon(dayStr).toLocaleDateString('ru-RU', {
    timeZone: MSK,
    day: 'numeric',
    month: 'short',
  });
}

function fmtRangeLabel(period: Period, from: string, to: string): string {
  if (period === 'day') return fmtDayTitle(from);
  const year = noon(to).toLocaleDateString('ru-RU', {
    timeZone: MSK,
    year: 'numeric',
  });
  return `${fmtShort(from)} — ${fmtShort(to)} ${year}`;
}

function ru(n: number): string {
  return n.toLocaleString('ru-RU');
}

function passportSub(ev: TimeTrackingEventDto): string {
  const parts: string[] = [];
  if (ev.passportSizeCode) parts.push(`р. ${ev.passportSizeCode}`);
  if (ev.passportColor) parts.push(ev.passportColor);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Компоненты
// ---------------------------------------------------------------------------

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
  foot?: React.ReactNode;
  tone?: 'warn' | 'live';
}) {
  const cls = [
    styles.kpi,
    tone === 'warn' ? styles.kpiWarn : '',
    tone === 'live' ? styles.kpiLive : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls}>
      <div className={styles.kpiLbl}>{label}</div>
      <div className={`${styles.kpiVal} ${styles.tnum}`}>
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {foot ? <div className={styles.kpiFoot}>{foot}</div> : null}
    </div>
  );
}

function TimelineRow({
  ev,
  session,
}: {
  ev: TimeTrackingEventDto;
  session: TimeTrackingSessionDto;
}) {
  if (ev.type === 'SESSION_START') {
    return (
      <li className={`${styles.ev} ${styles.evStart}`}>
        <span className={styles.mk} />
        <span className={styles.evt}>{fmtTime(ev.at)}</span>
        <div className={styles.evmain}>
          <div className={styles.evT}>
            <b>Начало сеанса</b>
          </div>
          <div className={styles.evS}>
            стол <span className={styles.mono}>{session.equipmentCode}</span> ·{' '}
            {session.equipmentName}
          </div>
        </div>
      </li>
    );
  }
  if (ev.type === 'OPERATION_FINISHED') {
    return (
      <li className={`${styles.ev} ${styles.evFinish}`}>
        <span className={styles.mk} />
        <span className={styles.evt}>{fmtTime(ev.at)}</span>
        <div className={styles.evmain}>
          <div className={styles.evT}>{ev.operationName ?? 'Операция'}</div>
          <div className={styles.evS}>
            <span className={styles.pass}>{ev.passportNumber ?? '—'}</span>
            {passportSub(ev) ? ` · ${passportSub(ev)}` : ''}
          </div>
        </div>
        <div className={styles.evRight}>
          <span className={`${styles.chip} ${styles.chipGood}`}>
            +{ru(ev.qty ?? 0)} шт
          </span>
        </div>
      </li>
    );
  }
  if (ev.type === 'ISSUED_TO_EMPLOYEE') {
    return (
      <li className={`${styles.ev} ${styles.evIssue} ${styles.evMuted}`}>
        <span className={styles.mk} />
        <span className={styles.evt}>{fmtTime(ev.at)}</span>
        <div className={styles.evmain}>
          <div className={styles.evT}>Взят крой</div>
          <div className={styles.evS}>
            <span className={styles.pass}>{ev.passportNumber ?? '—'}</span>
            {passportSub(ev) ? ` · ${passportSub(ev)}` : ''}
          </div>
        </div>
      </li>
    );
  }
  if (ev.type === 'IN_PROGRESS') {
    return (
      <li className={`${styles.ev} ${styles.evLive}`}>
        <span className={styles.mk} />
        <span className={styles.evt}>{fmtTime(ev.at)}</span>
        <div className={styles.evmain}>
          <div className={styles.evT}>
            <b>Сеанс продолжается</b>
          </div>
          <div className={styles.evS}>
            операция «{session.operationName}» · часы идут
          </div>
        </div>
        <div className={styles.evRight}>
          <span className={`${styles.chip} ${styles.chipPlain}`}>
            идёт сейчас
          </span>
        </div>
      </li>
    );
  }
  // SESSION_END
  return (
    <li className={`${styles.ev} ${styles.evEnd}`}>
      <span className={styles.mk} />
      <span className={styles.evt}>{fmtTime(ev.at)}</span>
      <div className={styles.evmain}>
        <div className={styles.evT}>
          <b>Конец сеанса</b>
        </div>
        <div className={styles.evS}>
          итог: {ru(session.operationsCount)} оп · {ru(session.qtyGood)} шт ·{' '}
          {fmtDurLabel(session.durationMinutes)}
        </div>
      </div>
    </li>
  );
}

function SessionCard({
  session,
  defaultOpen,
}: {
  session: TimeTrackingSessionDto;
  defaultOpen: boolean;
}) {
  const cls = [styles.sess, session.open ? styles.sessLive : '']
    .filter(Boolean)
    .join(' ');
  return (
    <details className={cls} open={defaultOpen || session.open}>
      <summary className={styles.srow}>
        <ChevronRight className={styles.chev} size={16} strokeWidth={2.4} aria-hidden />
        <span className={styles.stime}>
          {fmtTime(session.startedAt)}{' '}
          {session.open ? (
            <>
              <span className={styles.to}>→</span>{' '}
              <span className={styles.now}>идёт сейчас</span>
            </>
          ) : (
            <span className={styles.to}>→ {fmtTime(session.endedAt as string)}</span>
          )}
        </span>
        <div className={styles.smid}>
          <span className={styles.smidOp}>{session.operationName}</span>
          <span className={styles.smidMach}>
            стол <span className={styles.k}>{session.equipmentCode}</span> ·{' '}
            {session.equipmentName}
          </span>
        </div>
        <div className={styles.sright}>
          <div className={`${styles.stat} ${styles.statHideSm}`}>
            <span className={styles.statN}>{ru(session.operationsCount)}</span>
            <span className={styles.statC}>операций</span>
          </div>
          <div className={styles.stat}>
            <span
              className={`${styles.statN} ${
                session.qtyGood === 0 ? styles.statNmuted : ''
              }`}
            >
              {session.qtyGood > 0 ? ru(session.qtyGood) : '—'}
            </span>
            <span className={styles.statC}>шт</span>
          </div>
          <span className={`${styles.dur} ${session.open ? styles.durLive : ''}`}>
            {session.open ? <span className={styles.dotLive} /> : null}
            {fmtDurLabel(session.durationMinutes)}
          </span>
        </div>
      </summary>
      {session.operationsCount === 0 && !session.open ? (
        <div className={styles.idle}>
          <Clock3 size={15} strokeWidth={1.8} aria-hidden />
          За сеанс не завершено ни одной операции — вероятно, короткий простой
          или ошибочный скан стола.
        </div>
      ) : (
        <div className={styles.sbody}>
          <ol className={styles.tl}>
            {session.events.map((ev, i) => (
              <TimelineRow key={`${ev.type}-${ev.at}-${i}`} ev={ev} session={session} />
            ))}
          </ol>
        </div>
      )}
    </details>
  );
}

// ---------------------------------------------------------------------------
// Страница
// ---------------------------------------------------------------------------

export default async function EmployeeTimeTrackerPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { period?: string; date?: string };
}) {
  const period: Period =
    searchParams.period === 'day' || searchParams.period === 'month'
      ? searchParams.period
      : 'week';
  const anchor =
    searchParams.date && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date)
      ? searchParams.date
      : moscowToday();
  const { from, to } = computeRange(period, anchor);

  let data: TimeTrackingDto;
  try {
    data = await getEmployeeTimeTracking(params.id, { from, to });
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  const basePath = `/admin/employees/${params.id}/time-tracker`;
  const periods: Array<{ key: Period; label: string }> = [
    { key: 'day', label: 'День' },
    { key: 'week', label: 'Неделя' },
    { key: 'month', label: 'Месяц' },
  ];

  const perHour =
    data.totalMinutes > 0
      ? Math.round(data.qtyGood / (data.totalMinutes / 60))
      : 0;
  const defectPct =
    data.qtyGood > 0 ? (data.defects / data.qtyGood) * 100 : 0;

  // Полоса «часы по дням»: все дни диапазона, слитые с byDay.
  const byDayMap = new Map(data.byDay.map((d) => [d.day, d]));
  const days = eachDay(from, to);
  const maxMinutes = Math.max(
    1,
    ...days.map((d) => byDayMap.get(d)?.minutes ?? 0),
  );
  const today = moscowToday();

  // Сеансы, сгруппированные по дню (сеансы уже новые сверху).
  const groups: Array<{ day: string; sessions: TimeTrackingSessionDto[] }> = [];
  for (const s of data.sessions) {
    const day = s.startedAt.slice(0, 10);
    const g = groups.find((x) => x.day === day);
    if (g) g.sessions.push(s);
    else groups.push({ day, sessions: [s] });
  }
  let firstSessionSeen = false;

  return (
    <AdminPageShell
      icon={<Clock3 size={22} strokeWidth={1.6} aria-hidden />}
      title={data.employeeName}
      subtitle={`Тайм-трекер · ${formatRole(data.role)}`}
      actions={
        <Link href={`/admin/employees/${params.id}`} className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К карточке
        </Link>
      }
    >
      {/* период */}
      <div className={styles.periodBar}>
        <div className={styles.seg} role="group" aria-label="Период">
          {periods.map((p) => (
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

      {/* KPI */}
      <div className={styles.kpis}>
        <Kpi
          label="Отработано"
          value={fmtDurLabel(data.totalMinutes)}
          tone={data.openSessionsCount > 0 ? 'live' : undefined}
          foot={data.openSessionsCount > 0 ? 'смена идёт' : 'за период'}
        />
        <Kpi
          label="Сеансов"
          value={ru(data.sessionsCount)}
          foot={
            data.openSessionsCount > 0
              ? `${data.openSessionsCount} идёт сейчас`
              : 'за период'
          }
        />
        <Kpi
          label="Операций"
          value={ru(data.operationsCount)}
          foot="завершено"
        />
        <Kpi label="Выработка" value={ru(data.qtyGood)} unit="шт" />
        <Kpi
          label="Выработка/час"
          value={ru(perHour)}
          unit="шт/ч"
          foot="по факту завершений"
        />
        <Kpi
          label="Брак"
          value={ru(data.defects)}
          unit="шт"
          tone="warn"
          foot={
            data.qtyGood > 0
              ? `${defectPct.toLocaleString('ru-RU', {
                  maximumFractionDigits: 2,
                })}% от выработки`
              : '—'
          }
        />
      </div>

      {/* часы по дням */}
      {period !== 'day' && (
        <div className={styles.card}>
          <div className={styles.cardHd}>
            <h3>Часы по дням</h3>
            <span className="muted">
              нажмите день, чтобы раскрыть его сеансы · всего:{' '}
              <b>{fmtDurLabel(data.totalMinutes)}</b>
            </span>
          </div>
          <div className={styles.barsScroll}>
            <div className={styles.bars}>
              {days.map((day) => {
                const entry = byDayMap.get(day);
                const minutes = entry?.minutes ?? 0;
                const dt = noon(day);
                const wd = dt.getUTCDay(); // 0 вс .. 6 сб
                const weekend = wd === 0 || wd === 6;
                const height =
                  minutes > 0
                    ? Math.max(6, Math.round((minutes / maxMinutes) * 100))
                    : 0;
                const barCls = [
                  styles.bar,
                  day === today ? styles.barSel : '',
                  weekend ? styles.barWknd : '',
                  minutes === 0 ? styles.barZero : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const hoursLabel =
                  minutes > 0
                    ? (minutes / 60).toLocaleString('ru-RU', {
                        maximumFractionDigits: 1,
                      })
                    : '—';
                const wdShort = cap(
                  dt.toLocaleDateString('ru-RU', {
                    timeZone: MSK,
                    weekday: 'short',
                  }),
                );
                const dnum = dt.toLocaleDateString('ru-RU', {
                  timeZone: MSK,
                  day: 'numeric',
                });
                return (
                  <Link
                    key={day}
                    href={`${basePath}?period=day&date=${day}`}
                    className={barCls}
                  >
                    <span className={styles.barH}>{hoursLabel}</span>
                    <span className={styles.barColWrap}>
                      <span
                        className={styles.barCol}
                        style={height ? { height: `${height}px` } : undefined}
                      />
                    </span>
                    <span className={styles.barD}>
                      {wdShort} {dnum}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* сеансы по дням */}
      {groups.length === 0 ? (
        <div className={styles.empty}>
          Нет сеансов за выбранный период. Смена открывается сканом рабочего
          стола на терминале.
        </div>
      ) : (
        groups.map((g) => {
          const d = byDayMap.get(g.day);
          return (
            <section key={g.day}>
              <div className={styles.dayHd}>
                <h2>{fmtDayTitle(g.day)}</h2>
                <span className="m">
                  {g.sessions.length} сеанс(ов)
                  {d
                    ? ` · ${fmtDurLabel(d.minutes)} · ${ru(
                        d.operationsCount,
                      )} оп · ${ru(d.qtyGood)} шт${
                        d.defects > 0 ? ` · ${ru(d.defects)} брак` : ''
                      }`
                    : ''}
                </span>
              </div>
              {g.sessions.map((s) => {
                const openFirst = !firstSessionSeen;
                firstSessionSeen = true;
                return (
                  <SessionCard key={s.id} session={s} defaultOpen={openFirst} />
                );
              })}
            </section>
          );
        })
      )}

      <div className={styles.note}>
        <Info size={15} strokeWidth={1.8} aria-hidden />
        <span>
          Сеанс = смена (скан рабочего стола). Внутри показаны{' '}
          <b>завершения операций</b> и выдачи кроя — точные интервалы каждой
          операции не фиксируются, поэтому загрузка оценивается по факту
          завершений (шт/час), а открытый сеанс считается до момента открытия
          страницы. Брак атрибутируется исполнителю операции — как в
          «Статистике по сотрудникам».
        </span>
      </div>
    </AdminPageShell>
  );
}
