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
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  MasterEmployeeDayDto,
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await loadEmployeeDayAction({ employeeId, date });
    if (r.ok) setDay(r.data);
    else setError(r.error);
    setLoading(false);
  }, [employeeId, date]);

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
              onClick={() => onDateChange(shiftDay(date, -1))}
              aria-label="Предыдущий день"
            >
              ‹
            </button>
            <span className="mday__date">{formatDayTitle(date)}</span>
            <button
              type="button"
              className="mday__nav"
              onClick={() => onDateChange(shiftDay(date, 1))}
              aria-label="Следующий день"
            >
              ›
            </button>
          </div>

          {day && (
            <div className="mday__kpis">
              <div className="mday__kpi">
                <div className="mday__kpi-label">На работе</div>
                <div className="mday__kpi-value">
                  {formatHM(day.presenceMinutes)}
                </div>
                <div className="mday__kpi-hint">
                  {day.segments.length > 0
                    ? `${moscowTimeHM(day.segments[0]!.startedAt)}→${
                        day.hasOpenSegment
                          ? 'сейчас'
                          : moscowTimeHM(
                              day.segments[day.segments.length - 1]!.endedAt ??
                                day.now,
                            )
                      }`
                    : 'не выходил'}
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

          {day && lane.length > 0 && (
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
