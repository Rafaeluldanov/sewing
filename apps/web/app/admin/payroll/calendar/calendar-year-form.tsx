'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Save, Wand2 } from 'lucide-react';
import {
  MONTH_LABELS,
  defaultMonthNorm,
  type PayrollCalendarMonthDto,
} from '@sewing/shared/payroll-calendar';
import { savePayrollCalendarYearAction } from './actions';
import {
  initialPayrollCalendarState,
  type PayrollCalendarState,
} from './form-state';

interface Props {
  year: number;
  months: PayrollCalendarMonthDto[];
}

interface RowState {
  normDays: string;
  normHours: string;
  comment: string;
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить год'}
    </button>
  );
}

/**
 * Форма норм года (12 строк) для `/admin/payroll/calendar`.
 *
 * Почему год целиком, а не строка за раз: производственный календарь
 * заполняют один раз в декабре на весь следующий год. Двенадцать
 * отдельных сабмитов на такую задачу — двенадцать поводов бросить её
 * на середине и оставить половину месяцев пустыми, а пустой месяц
 * тихо уводит расчёт на дефолтную норму.
 *
 * Пустая пара «дни + часы» = месяц не ведётся (строка удаляется).
 */
export function PayrollCalendarYearForm({ year, months }: Props) {
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const [rows, setRows] = useState<RowState[]>(() =>
    Array.from({ length: 12 }, (_, i) => {
      const row = byMonth.get(i + 1);
      return {
        normDays: row ? String(row.normDays) : '',
        normHours: row ? String(row.normHours) : '',
        comment: row?.comment ?? '',
      };
    }),
  );

  const [state, formAction] = useFormState<PayrollCalendarState, FormData>(
    savePayrollCalendarYearAction,
    initialPayrollCalendarState,
  );

  const patch = (index: number, next: Partial<RowState>) => {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...next } : r)),
    );
  };

  /**
   * Заполнить пустые месяцы черновой нормой «будни × 8 ч». Праздники
   * не учитываются (см. `defaultMonthNorm`) — это стартовая точка,
   * которую менеджер правит по официальному календарю. Уже
   * заполненные месяцы не трогаем: затирать введённое руками одним
   * кликом — верный способ потерять переносы.
   */
  const fillEmptyWithDefaults = () => {
    setRows((prev) =>
      prev.map((r, i) => {
        if (r.normDays !== '' || r.normHours !== '') return r;
        const def = defaultMonthNorm(year, i + 1);
        return {
          ...r,
          normDays: String(def.normDays),
          normHours: String(def.normHours),
        };
      }),
    );
  };

  return (
    <form action={formAction} className="admin-form">
      <input type="hidden" name="year" value={year} />

      {state.error && (
        <div
          role="alert"
          style={{ color: 'var(--admin-danger-fg)', fontSize: '0.88rem' }}
        >
          {state.error}
          {state.errorRequestId && (
            <span className="admin-muted" style={{ marginLeft: 6 }}>
              req: <code>{state.errorRequestId}</code>
            </span>
          )}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
          {state.successMessage}
        </div>
      )}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Месяц</th>
              <th>Норма дней</th>
              <th>Норма часов</th>
              <th>Комментарий</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const month = i + 1;
              const filled = row.normDays !== '' || row.normHours !== '';
              return (
                <tr key={month}>
                  <td>
                    {MONTH_LABELS[i]}
                    {!filled ? (
                      <span className="admin-muted"> · не заполнен</span>
                    ) : null}
                  </td>
                  <td>
                    <input
                      name={`normDays-${month}`}
                      type="text"
                      inputMode="numeric"
                      value={row.normDays}
                      onChange={(e) =>
                        patch(i, { normDays: e.target.value })
                      }
                      aria-label={`Норма дней, ${MONTH_LABELS[i]}`}
                      autoComplete="off"
                      style={{ width: '5rem' }}
                    />
                  </td>
                  <td>
                    <input
                      name={`normHours-${month}`}
                      type="text"
                      inputMode="decimal"
                      value={row.normHours}
                      onChange={(e) =>
                        patch(i, { normHours: e.target.value })
                      }
                      aria-label={`Норма часов, ${MONTH_LABELS[i]}`}
                      autoComplete="off"
                      style={{ width: '6rem' }}
                    />
                  </td>
                  <td>
                    <input
                      name={`comment-${month}`}
                      type="text"
                      maxLength={500}
                      value={row.comment}
                      onChange={(e) => patch(i, { comment: e.target.value })}
                      aria-label={`Комментарий, ${MONTH_LABELS[i]}`}
                      placeholder="например, перенос с 8 марта"
                      autoComplete="off"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="admin-actions-row">
        <SaveButton />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={fillEmptyWithDefaults}
        >
          <Wand2 size={16} strokeWidth={1.6} aria-hidden />
          Заполнить пустые по 5-дневке
        </button>
      </div>
    </form>
  );
}
