'use client';

/**
 * Вкладка «Сотрудники» кабинета мастера — статистика «кто сколько
 * сделал» (см. `packages/shared/src/master-employee-stats.ts`,
 * `apps/api/src/modules/master-employee-stats/*`).
 *
 * По умолчанию показываем статистику за СЕГОДНЯ; сверху мастер может
 * расширить период — пресеты «Сегодня»/7/14/30 дн или вручную поля
 * `с`/`по`. Таблица — строка = сотрудник, превью его операций + итоги
 * (паспортов / штук / брак). Клик по строке → провал в overlay с полной
 * разбивкой по операциям и по дням (зеркало drill «Движения тиража»).
 *
 * Брак атрибутируется исполнителю операции («брак, найденный на
 * операциях, которые закрыл сотрудник») — не тому, кто его зафиксировал.
 *
 * Даты считаем в `Europe/Moscow` (см. memory `feedback_hydration_timezone`)
 * и инициализируем уже после монтирования, чтобы не ловить рассинхрон
 * гидрации server/client.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  MasterEmployeeDrillDto,
  MasterEmployeeStatRowDto,
  MasterEmployeeStatsDto,
} from '@sewing/shared';
import {
  loadEmployeeStatsAction,
  loadEmployeeStatsDrillAction,
} from './employee-stats-actions';

// Пресеты периода в днях. 1 = «Сегодня» (стартовый режим).
const PRESETS: { days: number; label: string }[] = [
  { days: 1, label: 'Сегодня' },
  { days: 7, label: '7 дн' },
  { days: 14, label: '14 дн' },
  { days: 30, label: '30 дн' },
];
const DEFAULT_DAYS = 1;

const ROLE_LABELS: Record<string, string> = {
  SHOP_MANAGER: 'Руководитель',
  CUTTER: 'Закройщик',
  CUTTER_ASSISTANT: 'Помощник закройщика',
  SEAMSTRESS: 'Швея',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
  ADMIN: 'Администратор',
  SHOPFLOOR_MASTER: 'Мастер цеха',
  CONSTRUCTOR: 'Конструктор',
};

/** `YYYY-MM-DD` для Date в часовом поясе Москвы (en-CA → ISO-формат). */
function moscowDayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Диапазон последних `days` дней (включая сегодня) по Москве. */
function presetRange(days: number): { from: string; to: string } {
  const now = Date.now();
  const to = moscowDayKey(new Date(now));
  const from = moscowDayKey(new Date(now - (days - 1) * 24 * 60 * 60 * 1000));
  return { from, to };
}

function OpsPreview({ row }: { row: MasterEmployeeStatRowDto }) {
  const top = row.operations.slice(0, 3);
  const more = row.operations.length - top.length;
  if (top.length === 0) return <span className="pboard__muted">—</span>;
  return (
    <div className="mstat__ops">
      {top.map((o) => (
        <span
          key={o.operationId}
          className="mstat__op-chip"
          title={o.operationName}
        >
          {o.operationName} · <b>{o.qty}</b>
          {o.defects > 0 && (
            <span className="mstat__op-def"> ✗{o.defects}</span>
          )}
        </span>
      ))}
      {more > 0 && <span className="mstat__op-more">ещё {more}</span>}
    </div>
  );
}

export function EmployeeStatsView() {
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [activeDays, setActiveDays] = useState<number | null>(DEFAULT_DAYS);
  const [stats, setStats] = useState<MasterEmployeeStatsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<MasterEmployeeDrillDto | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const load = useCallback(async (f: string, t: string) => {
    if (!f || !t) return;
    setLoading(true);
    setError(null);
    const r = await loadEmployeeStatsAction({ from: f, to: t });
    if (r.ok) setStats(r.data);
    else setError(r.error);
    setLoading(false);
  }, []);

  // Инициализация дефолтного периода (сегодня) после монтирования —
  // Date.now недоступен на server-render без риска рассинхрона гидрации.
  useEffect(() => {
    const { from: f, to: t } = presetRange(DEFAULT_DAYS);
    setFrom(f);
    setTo(t);
    void load(f, t);
  }, [load]);

  const applyPreset = useCallback(
    (days: number) => {
      const { from: f, to: t } = presetRange(days);
      setFrom(f);
      setTo(t);
      setActiveDays(days);
      void load(f, t);
    },
    [load],
  );

  const onManualDate = useCallback(
    (which: 'from' | 'to', value: string) => {
      setActiveDays(null);
      if (which === 'from') {
        setFrom(value);
        void load(value, to);
      } else {
        setTo(value);
        void load(from, value);
      }
    },
    [from, to, load],
  );

  const openDrill = useCallback(
    async (employeeId: string) => {
      if (!from || !to) return;
      setDrillLoading(true);
      setDrill(null);
      const r = await loadEmployeeStatsDrillAction({ employeeId, from, to });
      if (r.ok) setDrill(r.data);
      else setError(r.error);
      setDrillLoading(false);
    },
    [from, to],
  );

  const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;

  return (
    <div className="mstat">
      <div className="mstat__bar">
        <div className="mstat__presets">
          {PRESETS.map((p) => (
            <button
              key={p.days}
              type="button"
              className={
                'pboard__period' + (p.days === activeDays ? ' is-active' : '')
              }
              onClick={() => applyPreset(p.days)}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className="pboard__refresh"
            onClick={() => void load(from, to)}
            disabled={loading || !from || !to}
          >
            {loading ? 'Загрузка…' : '⟳ Обновить'}
          </button>
        </div>
        <div className="mstat__dates">
          <label className="mstat__date-field">
            <span className="pboard__muted">с</span>
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => onManualDate('from', e.target.value)}
            />
          </label>
          <label className="mstat__date-field">
            <span className="pboard__muted">по</span>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => onManualDate('to', e.target.value)}
            />
          </label>
        </div>
      </div>

      {error && (
        <div className="master-page__error" role="alert">
          {error}
        </div>
      )}

      {!error && stats && stats.rows.length === 0 && (
        <div className="master-page__empty">
          <p>За выбранный период никто не закрывал операции</p>
        </div>
      )}

      {stats && stats.rows.length > 0 && (
        <table className="mstat__table">
          <thead>
            <tr>
              <th>Сотрудник</th>
              <th className="mstat__th-ops">Операции</th>
              <th className="mstat__num">Пасп.</th>
              <th className="mstat__num">Штук</th>
              <th className="mstat__num">Брак</th>
            </tr>
          </thead>
          <tbody>
            {stats.rows.map((row) => (
              <tr
                key={row.employeeId}
                className="mstat__row"
                onClick={() => void openDrill(row.employeeId)}
                tabIndex={0}
                role="button"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void openDrill(row.employeeId);
                  }
                }}
              >
                <td>
                  <div className="mstat__name">{row.employeeName}</div>
                  <div className="mstat__role">{roleLabel(row.role)}</div>
                </td>
                <td className="mstat__td-ops">
                  <OpsPreview row={row} />
                </td>
                <td className="mstat__num">{row.totalPassports}</td>
                <td className="mstat__num">
                  <b>{row.totalQty}</b>
                </td>
                <td className="mstat__num">
                  {row.totalDefects > 0 ? (
                    <span className="mstat__def">{row.totalDefects}</span>
                  ) : (
                    <span className="pboard__muted">0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(drill || drillLoading) && (
        <div
          className="pboard__overlay"
          onClick={() => {
            setDrill(null);
            setDrillLoading(false);
          }}
        >
          <div className="pboard__panel" onClick={(e) => e.stopPropagation()}>
            <div className="pboard__panel-head">
              <div>
                <div className="pboard__panel-title">
                  {drill ? drill.employeeName : 'Загрузка…'}
                </div>
                {drill && (
                  <div className="pboard__panel-sub">
                    {roleLabel(drill.role)} · {drill.from}
                    {drill.to !== drill.from ? ` — ${drill.to}` : ''}
                    <br />
                    {drill.totalPassports} пасп · <b>{drill.totalQty} шт</b> ·{' '}
                    {drill.totalOperations} опер.
                    {drill.totalDefects > 0 && (
                      <span className="mstat__def">
                        {' '}
                        · брак {drill.totalDefects}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="pboard__x"
                onClick={() => {
                  setDrill(null);
                  setDrillLoading(false);
                }}
              >
                ✕
              </button>
            </div>
            <div className="pboard__panel-body">
              {drillLoading && <div className="pboard__muted">Загрузка…</div>}
              {drill && (
                <>
                  <div className="mstat__drill-section">
                    <div className="mstat__drill-h">По операциям</div>
                    {drill.operations.length === 0 ? (
                      <div className="pboard__muted">Нет данных</div>
                    ) : (
                      drill.operations.map((o) => (
                        <div key={o.operationId} className="mstat__drill-op">
                          <span className="mstat__drill-op-name">
                            {o.operationName}
                          </span>
                          <span className="pboard__muted">
                            {o.passports} пасп · <b>{o.qty} шт</b>
                            {o.defects > 0 && (
                              <span className="mstat__def">
                                {' '}
                                · брак {o.defects}
                              </span>
                            )}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="mstat__drill-section">
                    <div className="mstat__drill-h">По дням</div>
                    {drill.byDay.length === 0 ? (
                      <div className="pboard__muted">Нет данных</div>
                    ) : (
                      drill.byDay.map((d) => (
                        <div key={d.day} className="mstat__drill-day">
                          <span>{d.day}</span>
                          <span className="pboard__muted">
                            {d.passports} пасп · <b>{d.qty} шт</b> ·{' '}
                            {d.operations} опер.
                            {d.defects > 0 && (
                              <span className="mstat__def">
                                {' '}
                                · брак {d.defects}
                              </span>
                            )}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
