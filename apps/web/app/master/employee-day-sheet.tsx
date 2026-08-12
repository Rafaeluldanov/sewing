'use client';

/**
 * «Табель дня» — шторка поверх вкладки «Сотрудники» в кабинете мастера:
 * где сотрудник был, сколько времени и сколько сделал за одни сутки.
 * Контракт — `MasterEmployeeDayDto` (`packages/shared/src/master-employee-stats.ts`),
 * ручка — `GET /api/master/employee-stats/day`.
 *
 * Почему шторка, а не страница `/master/employees/[id]`: вкладки
 * кабинета живут в `useState` (см. `master-page-client.tsx`), и переход
 * на отдельный маршрут с возвратом «назад» выкинул бы мастера на
 * вкладку «Доска». Тот же приём и та же разметка, что у
 * `passport-actions-sheet.tsx`.
 *
 * Лента дня — ВЕРТИКАЛЬНАЯ: кабинет мастера это полноэкранный терминал
 * шириной до 720px (`.master-page`), и горизонтальные 10 часов на
 * телефоне дают ~39px на час — двадцатиминутный перерыв превращается в
 * нечитаемую полоску без подписи. Вертикально высота = длительность, а
 * подпись всегда рядом.
 *
 * Паузы («вне смены») считаются здесь, а не на бэке: это просто зазоры
 * между соседними отрезками, и гонять их по сети незачем — бэк отдаёт
 * только агрегат (`idleMinutes`, `breaks`) для шапки.
 *
 * Три режима периода — «День · Неделя · Месяц». На периоде длиннее
 * суток лента дня НЕ показывается (семь суток отрезками на 390px не
 * читаются) — вместо неё график «Часы по дням», где столбик тапом
 * переключает табель на этот день. «Где был» и «По операциям» просто
 * считаются за период, вёрстка у них общая.
 *
 * Что происходило внутри отрезка (какие паспорта брал и закрывал),
 * раскрывается тапом: за смену набегает 20–40 событий, и развёрнутая
 * целиком лента листалась бы минуту, перестав отвечать на «где был» за
 * один взгляд.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  MasterEmployeeDayDto,
  MasterEmployeeDayEventDto,
  MasterEmployeeDaySegmentDto,
} from '@sewing/shared';
import { categoryClass, categoryLabel } from '@/lib/operation-category';
import { loadEmployeeDayAction } from './employee-stats-actions';

/** «7:57» — часы:минуты для итогов. */
export function formatHM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** «3 ч 20 мин» / «22 мин» — длительность в тексте. */
function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} мин`;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

/** «HH:MM» по Москве для ISO-строки. */
function moscowTimeHM(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** «Ср, 12 августа» для `YYYY-MM-DD`. */
function formatDayTitle(date: string): string {
  const d = new Date(`${date}T12:00:00.000+03:00`);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  }).format(d);
}

/** Сдвиг `YYYY-MM-DD` на ±N суток (по московскому полудню — DST не мешает). */
export function shiftDay(date: string, deltaDays: number): string {
  const base = new Date(`${date}T12:00:00.000+03:00`);
  base.setTime(base.getTime() + deltaDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(base);
}

export type DayPeriod = 'day' | 'week' | 'month';

/** Границы периода `[from; to]` (московские сутки) для якорной даты. */
export function periodRange(
  period: DayPeriod,
  anchor: string,
): { from: string; to: string } {
  if (period === 'day') return { from: anchor, to: anchor };
  if (period === 'week') {
    // Неделя с понедельника: `getUTCDay` на московском полудне даёт
    // правильный день недели без возни с локалью.
    const base = new Date(`${anchor}T12:00:00.000+03:00`);
    const shift = (base.getUTCDay() + 6) % 7;
    return { from: shiftDay(anchor, -shift), to: shiftDay(anchor, 6 - shift) };
  }
  const [y, m] = anchor.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

/** Сдвиг якоря на соседний период (стрелки «‹ ›»). */
export function shiftAnchor(
  period: DayPeriod,
  anchor: string,
  delta: number,
): string {
  if (period === 'day') return shiftDay(anchor, delta);
  if (period === 'week') return shiftDay(anchor, delta * 7);
  const [y, m] = anchor.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Все дни периода включительно — для графика (пустые дни тоже нужны). */
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  for (let guard = 0; cur <= to && guard < 400; guard += 1) {
    out.push(cur);
    cur = shiftDay(cur, 1);
  }
  return out;
}

/** «10 — 16 августа» / «Август 2026» — подпись периода. */
function formatPeriodTitle(period: DayPeriod, from: string, to: string): string {
  if (period === 'day') return formatDayTitle(from);
  const d = (iso: string) => new Date(`${iso}T12:00:00.000+03:00`);
  if (period === 'month') {
    const label = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      month: 'long',
      year: 'numeric',
    }).format(d(from));
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  const fromLabel = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: 'numeric',
  }).format(d(from));
  const toLabel = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: 'numeric',
    month: 'long',
  }).format(d(to));
  return `${fromLabel} — ${toLabel}`;
}

/** «пн 10» — подпись столбика графика. */
function formatDayShort(day: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    weekday: 'short',
    day: 'numeric',
  }).format(new Date(`${day}T12:00:00.000+03:00`));
}

/** Выходной? (для приглушённого столбика графика). */
function isWeekend(day: string): boolean {
  const wd = new Date(`${day}T12:00:00.000+03:00`).getUTCDay();
  return wd === 0 || wd === 6;
}

/** Сколько РАЗНЫХ паспортов затронуто отрезком (а не событий). */
function passportCount(events: MasterEmployeeDayEventDto[]): number {
  return new Set(
    events.map((e) => e.passportNumber).filter((n): n is string => !!n),
  ).size;
}

/** Склонение «паспорт/паспорта/паспортов». */
function passportsWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'паспорт';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'паспорта';
  return 'паспортов';
}

/**
 * Высота строки ленты. Пропорциональна длительности, но с полом: восьми-
 * минутный перерыв всё равно должен оставаться кликабельным и читаемым.
 */
function ribbonHeight(minutes: number): number {
  return Math.max(22, Math.min(160, Math.round(minutes * 0.62)));
}

type LaneItem =
  | { kind: 'seg'; seg: MasterEmployeeDaySegmentDto }
  | { kind: 'gap'; startedAt: string; minutes: number };

/** Отрезки + паузы между ними, в порядке времени. */
function buildLane(segments: MasterEmployeeDaySegmentDto[]): LaneItem[] {
  const out: LaneItem[] = [];
  segments.forEach((seg, i) => {
    if (i > 0) {
      const prev = segments[i - 1]!;
      const prevEnd = new Date(prev.endedAt ?? prev.startedAt).getTime();
      const currStart = new Date(seg.startedAt).getTime();
      const gapMin = Math.round((currStart - prevEnd) / 60_000);
      if (gapMin >= 1) {
        out.push({
          kind: 'gap',
          startedAt: new Date(prevEnd).toISOString(),
          minutes: gapMin,
        });
      }
    }
    out.push({ kind: 'seg', seg });
  });
  return out;
}

export function EmployeeDaySheet({
  employeeId,
  date,
  onDateChange,
  onClose,
}: {
  employeeId: string;
  date: string;
  onDateChange: (next: string) => void;
  onClose: () => void;
}) {
  const [day, setDay] = useState<MasterEmployeeDayDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<DayPeriod>('day');
  // Раскрытые отрезки (id) — что происходило внутри показываем по тапу.
  const [openSegments, setOpenSegments] = useState<Set<string>>(new Set());

  const range = periodRange(period, date);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await loadEmployeeDayAction({
      employeeId,
      from: range.from,
      to: range.to,
    });
    if (r.ok) setDay(r.data);
    else setError(r.error);
    setLoading(false);
  }, [employeeId, range.from, range.to]);

  const toggleSegment = useCallback((id: string) => {
    setOpenSegments((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Esc закрывает шторку — как в остальных оверлеях кабинета.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const lane = day ? buildLane(day.segments) : [];

  return (
    <div className="mday" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="mday__card" onClick={(e) => e.stopPropagation()}>
        <div className="mday__head">
          <button type="button" className="mday__back" onClick={onClose}>
            ‹ Сотрудники
          </button>
          <div className="mday__head-top">
            <div className="mday__id">
              <div className="mday__name">
                {day ? day.employeeName : 'Загрузка…'}
              </div>
              {day && day.hasOpenSegment && (
                <div className="mday__live">
                  <span className="mday__live-dot" /> на смене сейчас
                </div>
              )}
            </div>
            <button
              type="button"
              className="mday__x"
              onClick={onClose}
              aria-label="Закрыть"
            >
              ✕
            </button>
          </div>

          <div className="mday__datebar">
            <button
              type="button"
              className="mday__nav"
              onClick={() => onDateChange(shiftAnchor(period, date, -1))}
              aria-label="Предыдущий период"
            >
              ‹
            </button>
            <span className="mday__date">
              {formatPeriodTitle(period, range.from, range.to)}
            </span>
            <button
              type="button"
              className="mday__nav"
              onClick={() => onDateChange(shiftAnchor(period, date, 1))}
              aria-label="Следующий период"
            >
              ›
            </button>
          </div>

          <div className="mday__periods" role="tablist" aria-label="Период">
            {(
              [
                ['day', 'День'],
                ['week', 'Неделя'],
                ['month', 'Месяц'],
              ] as Array<[DayPeriod, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={period === key}
                className={
                  'mday__period' + (period === key ? ' is-active' : '')
                }
                onClick={() => setPeriod(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {day && (
            <div className="mday__kpis">
              <div className="mday__kpi">
                <div className="mday__kpi-label">На работе</div>
                <div className="mday__kpi-value">
                  {formatHM(day.presenceMinutes)}
                </div>
                <div className="mday__kpi-hint">
                  {day.segments.length === 0
                    ? 'не выходил'
                    : period === 'day'
                      ? `${moscowTimeHM(day.segments[0]!.startedAt)}→${
                          day.hasOpenSegment
                            ? 'сейчас'
                            : moscowTimeHM(
                                day.segments[day.segments.length - 1]!
                                  .endedAt ?? day.now,
                              )
                        }`
                      : `${day.byDay.length} дн.`}
                </div>
              </div>
              <div className="mday__kpi">
                <div className="mday__kpi-label">В смене</div>
                <div className="mday__kpi-value">
                  {formatHM(day.workedMinutes)}
                </div>
                <div className="mday__kpi-hint">
                  {day.utilization !== null
                    ? `загрузка ${day.utilization}%`
                    : '—'}
                </div>
              </div>
              <div className="mday__kpi">
                <div className="mday__kpi-label">Вне смены</div>
                <div className="mday__kpi-value">
                  {formatHM(day.idleMinutes)}
                </div>
                <div className="mday__kpi-hint">
                  {day.breaks > 0 ? `${day.breaks} перерыв(а)` : 'без пауз'}
                </div>
              </div>
              <div className="mday__kpi">
                <div className="mday__kpi-label">Сделано</div>
                <div className="mday__kpi-value">
                  {day.totalQty} <span className="mday__unit">шт</span>
                </div>
                <div className="mday__kpi-hint">
                  {day.operations.length} операц.
                </div>
              </div>
              <div
                className={
                  'mday__kpi' + (day.totalDefects > 0 ? ' is-bad' : '')
                }
              >
                <div className="mday__kpi-label">Брак</div>
                <div className="mday__kpi-value">
                  {day.totalDefects} <span className="mday__unit">шт</span>
                </div>
                <div className="mday__kpi-hint">
                  {day.totalQty > 0
                    ? `${((day.totalDefects / day.totalQty) * 100).toFixed(1)}%`
                    : '—'}
                </div>
              </div>
              <div className="mday__kpi">
                <div className="mday__kpi-label">Переходов</div>
                <div className="mday__kpi-value">{day.transitions}</div>
                <div className="mday__kpi-hint">
                  {day.places.length} участка
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mday__body">
          {loading && <div className="pboard__muted">Загрузка…</div>}
          {error && (
            <div className="master-page__error" role="alert">
              {error}
            </div>
          )}

          {day && !loading && day.segments.length === 0 && (
            <div className="master-page__empty">
              <p>В этот день сотрудник не открывал смену</p>
            </div>
          )}

          {day && day.places.length > 0 && (
            <section className="mday__section">
              <h4 className="mday__h">Где был</h4>
              <div className="mday__places">
                {day.places.map((p) => (
                  <div key={p.key} className="mday__place">
                    <span className="mday__place-name">
                      {categoryLabel(p.category)} ·{' '}
                      {p.equipmentDisplayNumber
                        ? `№${p.equipmentDisplayNumber}`
                        : p.equipmentName}
                    </span>
                    <span className="mday__place-time">
                      {formatHM(p.minutes)}
                    </span>
                    <span className="mday__place-bar">
                      <span
                        className={`mday__place-fill ${categoryClass(p.category)}`}
                        style={{ width: `${p.share}%` }}
                      />
                    </span>
                    <span className="mday__place-share">
                      {p.share}% времени в смене
                      {p.operations > 1 ? ` · ${p.operations} операции` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {day && period !== 'day' && (
            <section className="mday__section">
              <h4 className="mday__h">
                Часы по дням{' '}
                <span className="mday__note">тап по дню — его табель</span>
              </h4>
              <div className="mday__bars">
                {(() => {
                  const byDay = new Map(day.byDay.map((d) => [d.day, d]));
                  const days = eachDay(range.from, range.to);
                  const max = Math.max(
                    1,
                    ...days.map((d) => byDay.get(d)?.minutes ?? 0),
                  );
                  return days.map((d) => {
                    const minutes = byDay.get(d)?.minutes ?? 0;
                    return (
                      <button
                        key={d}
                        type="button"
                        className="mday__barcol"
                        onClick={() => {
                          // Тап по столбику — быстрый путь к нужному дню:
                          // листать стрелками до него дольше.
                          onDateChange(d);
                          setPeriod('day');
                        }}
                      >
                        <span className="mday__barval">
                          {minutes > 0 ? formatHM(minutes) : '—'}
                        </span>
                        <span
                          className={
                            'mday__bar' +
                            (minutes === 0 ? ' is-zero' : '') +
                            (isWeekend(d) ? ' is-wknd' : '')
                          }
                          style={
                            minutes > 0
                              ? { height: `${Math.max(6, (minutes / max) * 100)}%` }
                              : undefined
                          }
                        />
                        <span className="mday__barlab">{formatDayShort(d)}</span>
                      </button>
                    );
                  });
                })()}
              </div>
            </section>
          )}

          {day && period === 'day' && lane.length > 0 && (
            <section className="mday__section">
              <h4 className="mday__h">
                Лента дня{' '}
                <span className="mday__note">высота = длительность</span>
              </h4>
              <div className="mday__lane">
                {lane.map((item, i) =>
                  item.kind === 'gap' ? (
                    <div
                      key={`gap:${item.startedAt}:${i}`}
                      className="mday__row is-gap"
                      style={{ minHeight: ribbonHeight(item.minutes) }}
                    >
                      <span className="mday__row-time">
                        {moscowTimeHM(item.startedAt)}
                      </span>
                      <span className="mday__row-bar">
                        <i />
                      </span>
                      <span className="mday__row-body">
                        <span className="mday__row-title">
                          вне смены {formatDuration(item.minutes)}
                        </span>
                      </span>
                    </div>
                  ) : (
                    <div
                      key={item.seg.segmentId}
                      className={`mday__row ${categoryClass(item.seg.category)}`}
                      style={{ minHeight: ribbonHeight(item.seg.minutes) }}
                    >
                      <span className="mday__row-time">
                        {moscowTimeHM(item.seg.startedAt)}
                      </span>
                      <span className="mday__row-bar">
                        <i />
                      </span>
                      <span className="mday__row-body">
                        <span className="mday__row-title">
                          {item.seg.equipmentDisplayNumber
                            ? `${item.seg.equipmentName} №${item.seg.equipmentDisplayNumber}`
                            : item.seg.equipmentName}
                          {item.seg.isOpen && (
                            <span className="mday__tag is-live">идёт</span>
                          )}
                        </span>
                        <span className="mday__row-meta">
                          {item.seg.operationName} ·{' '}
                          {formatDuration(item.seg.minutes)}
                          {item.seg.qty > 0 ? ` · ${item.seg.qty} шт` : ''}
                        </span>
                        {item.seg.events.length > 0 && (
                          <>
                            <button
                              type="button"
                              className="mday__toggle"
                              aria-expanded={openSegments.has(item.seg.segmentId)}
                              onClick={() => toggleSegment(item.seg.segmentId)}
                            >
                              <span
                                className={
                                  'mday__chev' +
                                  (openSegments.has(item.seg.segmentId)
                                    ? ' is-open'
                                    : '')
                                }
                              >
                                ›
                              </span>{' '}
                              {passportCount(item.seg.events)}{' '}
                              {passportsWord(passportCount(item.seg.events))}
                            </button>
                            {openSegments.has(item.seg.segmentId) && (
                              <ul className="mday__events">
                                {item.seg.events.map((ev, i) => (
                                  <li
                                    key={`${ev.at}:${i}`}
                                    className={
                                      'mday__ev' +
                                      (ev.type === 'ISSUED_TO_EMPLOYEE'
                                        ? ' is-issue'
                                        : '')
                                    }
                                  >
                                    <span className="mday__ev-t">
                                      {moscowTimeHM(ev.at)}
                                    </span>
                                    <span className="mday__ev-main">
                                      <span className="mday__ev-title">
                                        {ev.type === 'ISSUED_TO_EMPLOYEE'
                                          ? 'Взял крой'
                                          : `Закрыл операцию${
                                              ev.qty !== null
                                                ? ` · ${ev.qty} шт`
                                                : ''
                                            }`}
                                      </span>
                                      <span className="mday__ev-sub">
                                        <b>{ev.passportNumber ?? '—'}</b>
                                        {[ev.passportColor, ev.passportSizeCode]
                                          .filter(Boolean)
                                          .join(', ')
                                          ? ` · ${[
                                              ev.passportColor,
                                              ev.passportSizeCode,
                                            ]
                                              .filter(Boolean)
                                              .join(', ')}`
                                          : ''}
                                      </span>
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                      </span>
                    </div>
                  ),
                )}
              </div>
            </section>
          )}

          {day && day.operations.length > 0 && (
            <section className="mday__section">
              <h4 className="mday__h">По операциям</h4>
              <div className="mday__ops">
                {day.operations.map((o) => (
                  <div key={o.operationId} className="mday__op">
                    <div className="mday__op-head">
                      <i className={`mday__dot ${categoryClass(o.category)}`} />
                      <span className="mday__op-name">{o.operationName}</span>
                    </div>
                    <div className="mday__op-grid">
                      <div>
                        <div className="mday__metric-k">Время</div>
                        <div className="mday__metric-v">
                          {formatHM(o.minutes)}
                        </div>
                      </div>
                      <div>
                        <div className="mday__metric-k">Штук</div>
                        <div className="mday__metric-v">{o.qty}</div>
                      </div>
                      <div>
                        <div className="mday__metric-k">Шт/ч</div>
                        <div className="mday__metric-v">
                          {o.minutes > 0
                            ? ((o.qty / o.minutes) * 60).toFixed(1)
                            : '—'}
                        </div>
                      </div>
                      <div>
                        <div className="mday__metric-k">
                          {o.defectsFound > 0 ? 'Нашла' : 'Брак'}
                        </div>
                        <div
                          className={
                            'mday__metric-v' +
                            (o.defects > 0 ? ' mstat__def' : '')
                          }
                        >
                          {o.defectsFound > 0 ? o.defectsFound : o.defects}
                        </div>
                      </div>
                    </div>
                    {o.normPercent !== null && (
                      <div className="mday__norm">
                        <span className="mday__norm-k">норма</span>
                        <span className="mday__norm-bar">
                          <i
                            className={
                              o.normPercent >= 100 ? 'is-ok' : 'is-low'
                            }
                            style={{
                              width: `${Math.min(100, o.normPercent)}%`,
                            }}
                          />
                        </span>
                        <span
                          className={
                            o.normPercent >= 100
                              ? 'mday__norm-ok'
                              : 'mday__norm-low'
                          }
                        >
                          {o.normPercent}%
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="mday__total">
                <span>Итого за день</span>
                <span>
                  {formatHM(day.workedMinutes)} · {day.totalQty} шт
                </span>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
