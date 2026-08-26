'use client';

/**
 * Форма правил начисления. `'use client'` нужен ради `useFormState` /
 * `useFormStatus` и живого добавления дней-чипов; страница-обёртка —
 * RSC.
 */

import type React from 'react';
import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useFormState, useFormStatus } from 'react-dom';
import {
  PAYROLL_CUTOFF_BASES,
  PAYROLL_CUTOFF_BASIS_HINTS,
  PAYROLL_CUTOFF_BASIS_LABELS,
  type PayrollAccrualScheduleDto,
  type PayrollCutoffBasis,
} from '@sewing/shared/payroll-schedule';
import { savePayrollScheduleAction, type PayrollScheduleActionState } from './actions';

const initialState: PayrollScheduleActionState = {};

/** Строка «галочка + подпись» — та же геометрия, что у inline-полей. */
const CHECK_ROW: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'flex-start',
  marginTop: '0.4rem',
};

/** Техническое условие отбора — показываем под каждым вариантом. */
const BASIS_CODE: Record<PayrollCutoffBasis, string> = {
  ORDER_COMPLETED: 'Order.completedAt ≤ дата начисления',
  PASSPORT_PACKED: 'OperationEntry.approvedAt ≤ дата начисления',
  WORK_DATE: 'OperationEntry.createdAt ≤ дата начисления',
};

export function PayrollScheduleForm({
  schedule,
}: {
  schedule: PayrollAccrualScheduleDto;
}) {
  const [state, formAction] = useFormState(savePayrollScheduleAction, initialState);
  const [days, setDays] = useState<number[]>(schedule.daysOfMonth);
  const [draftDay, setDraftDay] = useState('');
  const [basis, setBasis] = useState<PayrollCutoffBasis>(schedule.cutoffBasis);
  const [sewing, setSewing] = useState(schedule.appliesToSewing);
  const [cutting, setCutting] = useState(schedule.appliesToCutting);
  const router = useRouter();
  const pathname = usePathname();
  const [recalculating, startRecalc] = useTransition();

  /**
   * Пересчитать предпросмотр по ТЕКУЩЕМУ выбору, не сохраняя его.
   * Правило уезжает в query, страница-RSC перезапрашивает
   * `/payroll/schedule/preview` с ним — иначе карточка справа считала
   * бы по строке из БД и не реагировала на переключатель.
   */
  function syncPreview(next: {
    basis?: PayrollCutoffBasis;
    sewing?: boolean;
    cutting?: boolean;
  }) {
    const query = new URLSearchParams({
      cutoffBasis: next.basis ?? basis,
      appliesToSewing: (next.sewing ?? sewing) ? '1' : '0',
      appliesToCutting: (next.cutting ?? cutting) ? '1' : '0',
    });
    startRecalc(() => {
      router.replace(`${pathname}?${query.toString()}`, { scroll: false });
    });
  }

  function addDay() {
    const n = Number(draftDay);
    if (!Number.isInteger(n) || n < 1 || n > 31) return;
    setDays((prev) => [...new Set([...prev, n])].sort((a, b) => a - b));
    setDraftDay('');
  }

  return (
    <form action={formAction}>
      {state.error && (
        <div className="error-box" role="alert" style={{ marginBottom: '0.75rem' }}>
          {state.error}
          {state.errorRequestId && (
            <div style={{ fontSize: '0.8rem', marginTop: '0.25rem', opacity: 0.7 }}>
              requestId: {state.errorRequestId}
            </div>
          )}
        </div>
      )}
      {state.ok && (
        <div className="admin-hint" style={{ marginBottom: '0.75rem' }}>
          Правила сохранены.
        </div>
      )}

      {/* Дни месяца уходят на сервер одной строкой — см. action. */}
      <input type="hidden" name="daysOfMonth" value={days.join(',')} />

      <div className="admin-field">
        <label htmlFor="schedule-day">Числа месяца</label>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.35rem',
            alignItems: 'center',
          }}
        >
          {days.map((d) => (
            <span key={d} className="admin-chip">
              {d}
              <button
                type="button"
                aria-label={`Убрать ${d} число`}
                className="admin-chip__remove"
                onClick={() => setDays((prev) => prev.filter((x) => x !== d))}
              >
                ✕
              </button>
            </span>
          ))}
          <input
            id="schedule-day"
            type="number"
            min={1}
            max={31}
            value={draftDay}
            placeholder="день"
            style={{ width: '5.5rem' }}
            onChange={(e) => setDraftDay(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addDay();
              }
            }}
          />
          <button type="button" className="admin-btn admin-btn--ghost" onClick={addDay}>
            ＋ Добавить день
          </button>
        </div>
        <p className="admin-hint">
          Период документа считается от предыдущего дня начисления до текущего
          включительно. Если в месяце нет такого числа (31 в феврале) — берётся
          последний день месяца. Пустой список выключает расписание: система
          ведёт себя как раньше.
        </p>
      </div>

      <div className="admin-field">
        <label htmlFor="schedule-time">Время автоматического формирования</label>
        <input
          id="schedule-time"
          type="time"
          name="runAtLocalTime"
          defaultValue={schedule.runAtLocalTime}
          style={{ maxWidth: '10rem' }}
        />
        <p className="admin-hint">
          Московское время. Черновик создаётся при первом заходе в раздел
          зарплаты после этого часа в день начисления.
        </p>
      </div>

      <fieldset className="admin-field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>Что попадает в расчёт</legend>
        {PAYROLL_CUTOFF_BASES.map((code) => (
          <label
            key={code}
            style={{
              display: 'flex',
              gap: '0.5rem',
              alignItems: 'flex-start',
              padding: '0.55rem 0.65rem',
              marginTop: '0.35rem',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: basis === code ? 'var(--color-accent-soft)' : '#fff',
              borderColor:
                basis === code ? 'var(--color-accent)' : 'var(--color-border)',
            }}
          >
            <input
              type="radio"
              name="cutoffBasis"
              value={code}
              checked={basis === code}
              onChange={() => {
                setBasis(code);
                syncPreview({ basis: code });
              }}
              style={{ marginTop: '0.25rem' }}
            />
            <span>
              <span style={{ fontWeight: 600 }}>
                {PAYROLL_CUTOFF_BASIS_LABELS[code]}
              </span>
              <span className="admin-hint" style={{ display: 'block' }}>
                {PAYROLL_CUTOFF_BASIS_HINTS[code]}
              </span>
              <span
                className="admin-hint"
                style={{ display: 'block', opacity: 0.75 }}
              >
                {BASIS_CODE[code]}
              </span>
            </span>
          </label>
        ))}
        <p className="admin-hint">
          Правило действует на сдельщину. Оклад, часы смены и подкрой к заказу не
          привязаны и всегда входят по своей дате.
        </p>
        <p className="admin-hint">
          Во всех трёх вариантах в расчёт идёт только ПОДТВЕРЖДЁННАЯ сдельщина:
          подтверждение ставится закрытием коробки на упаковке. Незакрытая
          коробка не попадёт в документ ни при каком правиле.
        </p>
      </fieldset>

      <div className="admin-field">
        <span>Правило распространяется на</span>
        <label style={CHECK_ROW}>
          <input
            type="checkbox"
            name="appliesToSewing"
            checked={sewing}
            onChange={(e) => {
              setSewing(e.target.checked);
              syncPreview({ sewing: e.target.checked });
            }}
          />
          <span>
            Пошив, ОТК, ВТО (сдельно)
            <span className="admin-hint" style={{ display: 'block' }}>
              Начисления по операциям маршрута.
            </span>
          </span>
        </label>
        <label style={CHECK_ROW}>
          <input
            type="checkbox"
            name="appliesToCutting"
            checked={cutting}
            onChange={(e) => {
              setCutting(e.target.checked);
              syncPreview({ cutting: e.target.checked });
            }}
          />
          <span>
            Раскрой
            <span className="admin-hint" style={{ display: 'block' }}>
              Раскройщик получает деньги в момент выпуска паспорта, задолго до
              закрытия заказа. Выключено — раскрой платим по факту выпуска.
            </span>
          </span>
        </label>
        {!sewing && !cutting && (
          <p className="admin-hint" style={{ marginTop: '0.4rem' }}>
            Обе галки сняты — правило отсечки ни на что не влияет: в расчёт
            входит вся подтверждённая сдельщина, какой бы вариант выше ни был
            выбран.
          </p>
        )}
      </div>

      <div className="admin-field">
        <label style={CHECK_ROW}>
          <input
            type="checkbox"
            name="autoCreateDraft"
            defaultChecked={schedule.autoCreateDraft}
          />
          <span>
            Создавать черновик документа автоматически
            <span className="admin-hint" style={{ display: 'block' }}>
              Документ появляется в статусе «Черновик»: суммы посчитаны, деньги
              не ушли. Проведение остаётся ручным.
            </span>
          </span>
        </label>
      </div>

      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginTop: '1rem',
          alignItems: 'center',
        }}
      >
        <SubmitButton />
        {recalculating && (
          <span className="admin-hint">Пересчитываем предпросмотр…</span>
        )}
      </div>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn admin-btn--primary" disabled={pending}>
      {pending ? 'Сохранение...' : 'Сохранить'}
    </button>
  );
}
