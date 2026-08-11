'use client';

/**
 * Вкладка «Сотрудники» кабинета мастера — статистика «кто сколько
 * сделал» (см. `packages/shared/src/master-employee-stats.ts`,
 * `apps/api/src/modules/master-employee-stats/*`).
 *
 * По умолчанию показываем статистику за СЕГОДНЯ; сверху мастер может
 * расширить период — кнопка «Сегодня» (сброс на текущий день) или
 * вручную поля `с`/`по`. Таблица — строка = сотрудник, превью его операций + итоги
 * (паспортов / штук / брак). Клик по строке → провал в overlay с полной
 * разбивкой по операциям и по дням (зеркало drill «Движения тиража»).
 *
 * Брак атрибутируется исполнителю операции («брак, найденный на
 * операциях, которые закрыл сотрудник») — не тому, кто его зафиксировал.
 *
 * Второй режим вкладки — «Активные»: список открытых смен прямо сейчас
 * (сотрудники забывают закрываться), самые давние сверху, с кнопкой
 * принудительного завершения мастером. При паспортах на руках API
 * отвечает `409 SHIFT_HAS_ACTIVE_PASSPORTS` — показываем инлайн-
 * подтверждение в карточке и повторяем с `force: true`.
 *
 * Даты считаем в `Europe/Moscow` (см. memory `feedback_hydration_timezone`)
 * и инициализируем уже после монтирования, чтобы не ловить рассинхрон
 * гидрации server/client.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MasterActiveShiftDto,
  MasterActiveShiftsDto,
  MasterEmployeeAccessDto,
  MasterEmployeeDrillDto,
  MasterEmployeeStatRowDto,
  MasterEmployeeStatsDto,
} from '@sewing/shared';
import { MASTER_ASSIGNABLE_ROLES } from '@sewing/shared';
import { formatRole } from '@/lib/admin-labels';
import {
  closeActiveShiftAction,
  loadActiveShiftsAction,
  loadEmployeeAccessAction,
  loadEmployeeStatsAction,
  loadEmployeeStatsDrillAction,
  saveEmployeeAccessAction,
} from './employee-stats-actions';

// Пресеты периода в днях. Оставлен только «Сегодня» (стартовый режим);
// остальной период мастер задаёт вручную полями `с`/`по`.
const PRESETS: { days: number; label: string }[] = [
  { days: 1, label: 'Сегодня' },
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

/** «HH:MM» по Москве для ISO-строки. */
function moscowTimeHM(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** «DD.MM» по Москве для ISO-строки. */
function moscowDayMonth(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(iso));
}

/**
 * «N ч M мин» между стартом смены и серверным `now` (длительности
 * считаем от времени бэка, не от часов клиента).
 */
function shiftDuration(startedAt: string, now: string): string {
  const ms = Math.max(
    0,
    new Date(now).getTime() - new Date(startedAt).getTime(),
  );
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

/** Склонение «паспорт/паспорта/паспортов». */
function passportsWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'паспорт';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'паспорта';
  }
  return 'паспортов';
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

/**
 * Карточка одной открытой смены в режиме «Активные». `confirmCount` —
 * число паспортов для инлайн-подтверждения после
 * `409 SHIFT_HAS_ACTIVE_PASSPORTS` (`undefined` — обычная кнопка).
 */
function ActiveShiftCard({
  shift,
  now,
  confirmCount,
  closing,
  onClose,
  onCancel,
}: {
  shift: MasterActiveShiftDto;
  now: string;
  confirmCount: number | undefined;
  closing: boolean;
  onClose: (force: boolean) => void;
  onCancel: () => void;
}) {
  const nowMs = new Date(now).getTime();
  const startedDay = moscowDayKey(new Date(shift.startedAt));
  const today = moscowDayKey(new Date(nowMs));
  const yesterday = moscowDayKey(new Date(nowMs - 24 * 60 * 60 * 1000));
  const stale = startedDay < today;
  return (
    <div className="mstat__shift">
      <div className="mstat__shift-main">
        <div className="mstat__shift-head">
          <span className="mstat__name">{shift.employeeName}</span>
          <span className="mstat__shift-role">
            {ROLE_LABELS[shift.role] ?? shift.role}
          </span>
        </div>
        <div className="mstat__shift-meta">
          Стол {shift.equipmentDisplayNumber ?? shift.equipmentCode} ·{' '}
          {shift.equipmentName} · {shift.operationName}
          {shift.passportsInProgress > 0 && (
            <> · паспортов на руках: {shift.passportsInProgress}</>
          )}
        </div>
        <div className="mstat__shift-time">
          Начало {moscowTimeHM(shift.startedAt)} · длится{' '}
          {shiftDuration(shift.startedAt, now)}
        </div>
        {stale && (
          <div className="mstat__shift-warn">
            ⚠ Смена открыта{' '}
            {startedDay === yesterday
              ? 'со вчерашнего дня'
              : `с ${moscowDayMonth(shift.startedAt)}`}
          </div>
        )}
        {shift.hasActiveRecut && (
          <div className="mstat__shift-warn">
            ⚠ Активный подкрой — время продолжает идти
          </div>
        )}
      </div>
      <div className="mstat__shift-actions">
        {confirmCount === undefined ? (
          <button
            type="button"
            className="mstat__shift-close"
            disabled={closing}
            onClick={() => onClose(false)}
          >
            {closing ? 'Завершение…' : 'Завершить смену'}
          </button>
        ) : (
          <div className="mstat__shift-confirm">
            <span className="mstat__shift-confirm-text">
              На руках {confirmCount} {passportsWord(confirmCount)} в работе.
              Всё равно завершить?
            </span>
            <div className="mstat__shift-confirm-btns">
              <button
                type="button"
                className="mstat__shift-force"
                disabled={closing}
                onClick={() => onClose(true)}
              >
                {closing ? 'Завершение…' : 'Завершить'}
              </button>
              <button
                type="button"
                className="mstat__shift-cancel"
                disabled={closing}
                onClick={onCancel}
              >
                Отмена
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Карточка сотрудника в режиме «Доступы»: участки чипами, редактор —
 * тот же паттерн, что в админских «Ролях сотрудников» (клик по чипу
 * включает/выключает участок, ★ делает его основным), но список ролей
 * ограничен цеховыми (`MASTER_ASSIGNABLE_ROLES`).
 *
 * Отказ печатаем В КАРТОЧКЕ: список длинный, общая плашка ошибки
 * наверху страницы при прокрутке не видна и нажатие выглядит как
 * «ничего не произошло».
 */
function EmployeeAccessCard({
  row,
  onSaved,
}: {
  row: MasterEmployeeAccessDto;
  onSaved: (next: MasterEmployeeAccessDto) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [roles, setRoles] = useState<string[]>(row.roles);
  const [primary, setPrimary] = useState(row.primaryRole);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setRoles(row.roles);
    setPrimary(row.primaryRole);
    setError(null);
    setEditing(true);
  }

  function toggle(code: string) {
    setError(null);
    setRoles((prev) => {
      if (prev.includes(code)) {
        // Последний участок снять нельзя — сотрудник остался бы без
        // рабочего экрана (это же правило проверяет схема на бэке).
        if (prev.length === 1) return prev;
        const next = prev.filter((r) => r !== code);
        // Сняли основную — основной становится первая оставшаяся.
        if (code === primary) setPrimary(next[0]!);
        return next;
      }
      return [...prev, code];
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await saveEmployeeAccessAction(row.employeeId, {
      roles,
      primaryRole: primary,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditing(false);
    onSaved(res.data);
  }

  const shown = editing ? roles : row.roles;
  const shownPrimary = editing ? primary : row.primaryRole;

  return (
    <div className="maccess__row">
      <div className="maccess__head">
        <div>
          <div className="maccess__name">{row.employeeName}</div>
          <div className="maccess__meta">
            {row.activeShift
              ? `Смена: ${
                  row.activeShift.equipmentDisplayNumber ??
                  row.activeShift.equipmentName
                } · ${row.activeShift.operationName}`
              : 'Смена не открыта'}
          </div>
        </div>
        {!editing && row.editable && (
          <button type="button" className="maccess__edit" onClick={startEdit}>
            ✎ Изменить
          </button>
        )}
      </div>

      <div className="maccess__chips">
        {(editing ? MASTER_ASSIGNABLE_ROLES : shown).map((code) => {
          const on = shown.includes(code);
          const isPrimary = code === shownPrimary;
          return (
            <span
              key={code}
              className={
                'maccess__chip' +
                (on ? ' is-on' : '') +
                (isPrimary ? ' is-primary' : '')
              }
            >
              {editing ? (
                <button
                  type="button"
                  className="maccess__chip-toggle"
                  aria-pressed={on}
                  disabled={saving}
                  onClick={() => toggle(code)}
                >
                  {formatRole(code)}
                </button>
              ) : (
                <span className="maccess__chip-toggle">{formatRole(code)}</span>
              )}
              {on && editing && (
                <button
                  type="button"
                  className="maccess__chip-star"
                  title="Сделать основным участком"
                  aria-label={`Сделать «${formatRole(code)}» основным участком`}
                  disabled={saving}
                  onClick={() => setPrimary(code)}
                >
                  {isPrimary ? '★' : '☆'}
                </button>
              )}
              {on && !editing && isPrimary && (
                <span className="maccess__chip-star" aria-label="Основной участок">
                  ★
                </span>
              )}
            </span>
          );
        })}
      </div>

      {error && (
        <p className="maccess__error" role="alert">
          {error}
        </p>
      )}

      {!row.editable && !editing && (
        <p className="maccess__hint">
          Есть доступы вне цеха — их меняет начальник цеха.
        </p>
      )}

      {editing && (
        <>
          <div className="maccess__actions">
            <button
              type="button"
              className="maccess__save"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
            <button
              type="button"
              className="maccess__cancel"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Отмена
            </button>
          </div>
          <p className="maccess__hint">
            Клик по участку — доступ вкл/выкл. ★ — основной участок (экран
            по умолчанию). Переключается сотрудник сам — кнопкой «Сменить
            место» или сканом рабочего места.
          </p>
        </>
      )}
    </div>
  );
}

export function EmployeeStatsView() {
  const [mode, setMode] = useState<'stats' | 'active' | 'access'>('stats');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [activeDays, setActiveDays] = useState<number | null>(DEFAULT_DAYS);
  const [stats, setStats] = useState<MasterEmployeeStatsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<MasterEmployeeDrillDto | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  // Режим «Активные»: открытые смены + состояние закрытия.
  const [activeShifts, setActiveShifts] =
    useState<MasterActiveShiftsDto | null>(null);
  const [activeLoading, setActiveLoading] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  // shiftId → число паспортов для инлайн-подтверждения (после 409).
  const [confirmByShift, setConfirmByShift] = useState<
    Record<string, number>
  >({});
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Режим «Доступы»: участки сотрудников цеха.
  const [accessRows, setAccessRows] = useState<MasterEmployeeAccessDto[] | null>(
    null,
  );
  const [accessLoading, setAccessLoading] = useState(false);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const load = useCallback(async (f: string, t: string) => {
    if (!f || !t) return;
    setLoading(true);
    setError(null);
    const r = await loadEmployeeStatsAction({ from: f, to: t });
    if (r.ok) setStats(r.data);
    else setError(r.error);
    setLoading(false);
  }, []);

  const loadActive = useCallback(async () => {
    setActiveLoading(true);
    setError(null);
    const r = await loadActiveShiftsAction();
    if (r.ok) {
      setActiveShifts(r.data);
      // Пропавшие из списка смены убираем и из инлайн-подтверждений.
      setConfirmByShift((prev) => {
        const alive = new Set(r.data.rows.map((s) => s.shiftId));
        const next: Record<string, number> = {};
        for (const [id, n] of Object.entries(prev)) {
          if (alive.has(id)) next[id] = n;
        }
        return next;
      });
    } else {
      setError(r.error);
    }
    setActiveLoading(false);
  }, []);

  const loadAccess = useCallback(async () => {
    setAccessLoading(true);
    setError(null);
    const r = await loadEmployeeAccessAction();
    if (r.ok) setAccessRows(r.data.rows);
    else setError(r.error);
    setAccessLoading(false);
  }, []);

  // Инициализация дефолтного периода (сегодня) после монтирования —
  // Date.now недоступен на server-render без риска рассинхрона гидрации.
  // Активные смены грузим сразу же — счётчик в сегменте «Активные N».
  useEffect(() => {
    const { from: f, to: t } = presetRange(DEFAULT_DAYS);
    setFrom(f);
    setTo(t);
    void load(f, t);
    void loadActive();
  }, [load, loadActive]);

  const switchMode = useCallback(
    (m: 'stats' | 'active' | 'access') => {
      setMode(m);
      if (m === 'active') void loadActive();
      if (m === 'access') void loadAccess();
    },
    [loadActive, loadAccess],
  );

  const cancelConfirm = useCallback((shiftId: string) => {
    setConfirmByShift((prev) => {
      const next = { ...prev };
      delete next[shiftId];
      return next;
    });
  }, []);

  const closeShift = useCallback(
    async (shift: MasterActiveShiftDto, force: boolean) => {
      setClosingId(shift.shiftId);
      setError(null);
      const r = await closeActiveShiftAction(shift.shiftId, force);
      setClosingId(null);
      if (r.ok) {
        cancelConfirm(shift.shiftId);
        showToast(
          r.data.closed
            ? `Смена завершена: ${shift.employeeName}`
            : 'Смена уже закрыта',
        );
        void loadActive();
      } else if (r.needsForce) {
        // Количество в теле 409 не приезжает — берём из карточки
        // (свежий GET); минимум 1, раз API отказал из-за паспортов.
        setConfirmByShift((prev) => ({
          ...prev,
          [shift.shiftId]: Math.max(1, shift.passportsInProgress),
        }));
      } else {
        setError(r.error);
      }
    },
    [cancelConfirm, loadActive, showToast],
  );

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
        <div className="mstat__seg" role="tablist" aria-label="Режим вкладки">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'stats'}
            className={
              'mstat__seg-btn' + (mode === 'stats' ? ' is-active' : '')
            }
            onClick={() => switchMode('stats')}
          >
            Статистика
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'active'}
            className={
              'mstat__seg-btn' + (mode === 'active' ? ' is-active' : '')
            }
            onClick={() => switchMode('active')}
          >
            Активные
            {activeShifts && (
              <span className="mstat__seg-badge">
                {activeShifts.rows.length}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'access'}
            className={
              'mstat__seg-btn' + (mode === 'access' ? ' is-active' : '')
            }
            onClick={() => switchMode('access')}
          >
            Доступы
          </button>
        </div>
        {mode === 'stats' && (
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
          </div>
        )}
        <button
          type="button"
          className="pboard__refresh"
          onClick={() => {
            if (mode === 'stats') void load(from, to);
            else if (mode === 'active') void loadActive();
            else void loadAccess();
          }}
          disabled={
            mode === 'stats'
              ? loading || !from || !to
              : mode === 'active'
                ? activeLoading
                : accessLoading
          }
        >
          {(
            mode === 'stats'
              ? loading
              : mode === 'active'
                ? activeLoading
                : accessLoading
          )
            ? 'Загрузка…'
            : '⟳ Обновить'}
        </button>
        {mode === 'stats' && (
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
        )}
      </div>

      {error && (
        <div className="master-page__error" role="alert">
          {error}
        </div>
      )}

      {toast && (
        <div className="master-page__success" role="status" aria-live="polite">
          {toast}
        </div>
      )}

      {mode === 'active' && (
        <>
          {activeLoading && !activeShifts && (
            <div className="pboard__muted">Загрузка…</div>
          )}
          {!error && activeShifts && activeShifts.rows.length === 0 && (
            <div className="master-page__empty">
              <p>Открытых смен сейчас нет</p>
            </div>
          )}
          {activeShifts && activeShifts.rows.length > 0 && (
            <div className="mstat__shifts">
              {activeShifts.rows.map((s) => (
                <ActiveShiftCard
                  key={s.shiftId}
                  shift={s}
                  now={activeShifts.now}
                  confirmCount={confirmByShift[s.shiftId]}
                  closing={closingId === s.shiftId}
                  onClose={(force) => void closeShift(s, force)}
                  onCancel={() => cancelConfirm(s.shiftId)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {mode === 'access' && (
        <>
          {accessLoading && !accessRows && (
            <div className="pboard__muted">Загрузка…</div>
          )}
          {accessRows && accessRows.length === 0 && !error && (
            <div className="master-page__empty">
              <p>Активных сотрудников нет</p>
            </div>
          )}
          {accessRows && accessRows.length > 0 && (
            <div className="maccess">
              {accessRows.map((r) => (
                <EmployeeAccessCard
                  key={r.employeeId}
                  row={r}
                  onSaved={(next) => {
                    setAccessRows((prev) =>
                      prev
                        ? prev.map((x) =>
                            x.employeeId === next.employeeId
                              ? // Смена в ответе не приходит (её мастер
                                // видит в списке) — оставляем прежнюю.
                                { ...next, activeShift: x.activeShift }
                              : x,
                          )
                        : prev,
                    );
                    showToast(`Участки сохранены: ${next.employeeName}`);
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}

      {mode === 'stats' && !error && stats && stats.rows.length === 0 && (
        <div className="master-page__empty">
          <p>За выбранный период никто не закрывал операции</p>
        </div>
      )}

      {mode === 'stats' && stats && stats.rows.length > 0 && (
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
