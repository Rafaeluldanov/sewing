import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ChevronRight, Clock3, Info, Users } from 'lucide-react';
import type {
  TimeTrackingDto,
  TimeTrackingEventDto,
  TimeTrackingSessionDto,
} from '@sewing/shared';
import { ApiRequestError } from '@/lib/api';
import { getEmployeeTimeTracking } from '@/lib/time-tracking-api';
import { AdminPageShell } from '@/components/admin';
import { formatRole } from '@/lib/admin-labels';
import { categoryClass, categoryLabel } from '@/lib/operation-category';
import {
  MSK,
  cap,
  computeRange,
  eachDay,
  fmtDayTitle,
  fmtDurLabel,
  fmtRangeLabel,
  fmtTime,
  moscowToday,
  noon,
  normalizeAnchor,
  normalizePeriod,
  ru,
  type TtPeriod,
} from '@/lib/time-tracker-period';
import styles from './time-tracker.module.css';

export const dynamic = 'force-dynamic';

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
      ) : session.segments.length > 0 ? (
        // Отрезки: внутри одной смены операция могла переключаться, и
        // тогда «4:33 на оверлоке» — это две разные работы. События
        // паспортов лежат внутри своего отрезка, а не общей свалкой.
        <div className={styles.sbody}>
          {session.segments.map((seg) => (
            <div key={seg.id} className={styles.segRow}>
              <span className={`${styles.segTime} ${styles.tnum}`}>
                {fmtTime(seg.startedAt)}—
                {seg.endedAt ? fmtTime(seg.endedAt) : 'сейчас'}
              </span>
              <span className={styles.segBar}>
                <i className={categoryClass(seg.category)} />
              </span>
              <div className={styles.segMain}>
                <div className={styles.segTitle}>
                  {seg.operationName}
                  {seg.open ? (
                    <span className={`${styles.chip} ${styles.chipLive}`}>
                      идёт
                    </span>
                  ) : null}
                </div>
                <div className={styles.segMeta}>
                  {fmtDurLabel(seg.minutes)}
                  {seg.qtyGood > 0 ? ` · ${ru(seg.qtyGood)} шт` : ''}
                  {seg.minutes > 0 && seg.qtyGood > 0
                    ? ` · ${ru(Math.round((seg.qtyGood / seg.minutes) * 60))} шт/ч`
                    : ''}
                  {seg.normPercent !== null
                    ? ` · норма ${seg.normPercent}%`
                    : ''}
                </div>
                {seg.events.length > 0 && (
                  <ol className={styles.tl}>
                    {seg.events.map((ev, i) => (
                      <TimelineRow
                        key={`${ev.type}-${ev.at}-${i}`}
                        ev={ev}
                        session={session}
                      />
                    ))}
                  </ol>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        // Смена без отрезков (заведена до появления `ShiftSegment` и мимо
        // бэкфилла) — прежний плоский таймлайн.
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
  const period = normalizePeriod(searchParams.period);
  const anchor = normalizeAnchor(searchParams.date);
  const { from, to } = computeRange(period, anchor);

  let data: TimeTrackingDto;
  try {
    data = await getEmployeeTimeTracking(params.id, { from, to });
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  const basePath = `/admin/employees/${params.id}/time-tracker`;
  const periods: Array<{ key: TtPeriod; label: string }> = [
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
        <>
          <Link
            href="/admin/employees/time-tracker"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К обзору
          </Link>
          <Link
            href={`/admin/employees/${params.id}`}
            className="admin-btn admin-btn--ghost"
          >
            <Users size={16} strokeWidth={1.6} aria-hidden />
            Карточка
          </Link>
        </>
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
          label="На работе"
          value={fmtDurLabel(data.presenceMinutes)}
          foot={
            data.idleMinutes > 0
              ? `вне смены ${fmtDurLabel(data.idleMinutes)}`
              : 'без пауз'
          }
        />
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
          label="Загрузка"
          value={data.utilization !== null ? `${data.utilization}%` : '—'}
          foot={
            data.breaks > 0 ? `${ru(data.breaks)} перерыв(ов)` : 'в смене / на работе'
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
          label="Норма"
          value={data.normPercent !== null ? `${data.normPercent}%` : '—'}
          foot={
            data.normPercent !== null
              ? 'план к факту'
              : 'норма времени не задана'
          }
        />
        <Kpi
          label="Брак"
          value={ru(data.defects)}
          unit="шт"
          tone="warn"
          foot={
            [
              data.qtyGood > 0
                ? `${defectPct.toLocaleString('ru-RU', {
                    maximumFractionDigits: 2,
                  })}% от выработки`
                : null,
              // Брак, который сотрудник НАШЁЛ сам (работа ОТК) — другое
              // число, чем брак на его операциях; смешивать их нельзя.
              data.defectsFound > 0 ? `нашёл ${ru(data.defectsFound)}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || '—'
          }
        />
      </div>

      {/* где был — участки периода */}
      {data.places.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHd}>
            <h3>Где был</h3>
            <span className="muted">доля от времени в смене</span>
          </div>
          <div className={styles.places}>
            {data.places.map((p) => (
              <div key={p.key} className={styles.place}>
                <span className={styles.placeName}>
                  {categoryLabel(p.category)} ·{' '}
                  {p.equipmentDisplayNumber
                    ? `№${p.equipmentDisplayNumber}`
                    : p.equipmentName}
                </span>
                <span className={`${styles.placeTime} ${styles.tnum}`}>
                  {fmtDurLabel(p.minutes)}
                </span>
                <span className={styles.placeBar}>
                  <span
                    className={`${styles.placeFill} ${categoryClass(p.category)}`}
                    style={{ width: `${p.share}%` }}
                  />
                </span>
                <span className={styles.placeShare}>
                  {p.share}%
                  {p.operations > 1 ? ` · ${ru(p.operations)} операции` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

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
