'use client';

/**
 * Клиентская форма создания документа начисления зарплаты.
 * Требует 'use client' для `useFormState` / `useFormStatus`.
 *
 * Страница-обёртка (`new/page.tsx`) — RSC.
 */

import { useFormState, useFormStatus } from 'react-dom';
import type { EmployeeListItemDto } from '@sewing/shared/employees';
import { createPayrollAccrualDocumentAction } from '../actions';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';
import type { AccrualDocumentActionState } from '../actions';

const initialState: AccrualDocumentActionState = {};

function ruDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function CreateAccrualDocumentForm({
  employees,
  defaultAccrualDate = null,
  periodFrom = null,
  nextScheduledDate = null,
}: {
  employees: EmployeeListItemDto[];
  /**
   * Ближайший день начисления из расписания
   * (`PayrollAccrualSchedule`). `null` — расписание выключено, дата по
   * умолчанию остаётся «сегодня», как было до появления фичи.
   */
  defaultAccrualDate?: string | null;
  /** Начало периода этого начисления — для подписи под полем. */
  periodFrom?: string | null;
  /**
   * Ближайший день начисления, если он ЕЩЁ НЕ наступил. Тогда дату не
   * подставляем (документ собрал бы работу по сегодня, а период показал
   * бы по будущую дату), но показываем, когда начисление по расписанию.
   */
  nextScheduledDate?: string | null;
}) {
  const [state, formAction] = useFormState(
    createPayrollAccrualDocumentAction,
    initialState,
  );

  const sortedEmployees = [...employees].sort((a, b) =>
    a.fullName.localeCompare(b.fullName, 'ru'),
  );

  return (
    <form action={formAction} className="admin-form-grid">
      {state.error && (
        <div
          className="error-box"
          role="alert"
          style={{ gridColumn: '1 / -1' }}
        >
          {state.error}
          {state.errorRequestId && (
            <div
              style={{
                fontSize: '0.8rem',
                marginTop: '0.25rem',
                opacity: 0.7,
              }}
            >
              requestId: {state.errorRequestId}
            </div>
          )}
        </div>
      )}

      <div className="admin-field">
        <label htmlFor="create-ad-date">Дата начисления *</label>
        <input
          id="create-ad-date"
          type="date"
          name="accrualDate"
          required
          defaultValue={defaultAccrualDate ?? todayIso()}
        />
        <p className="admin-hint">
          {defaultAccrualDate ? (
            <>
              Дата подставлена по расписанию начисления
              {periodFrom ? ` (период ${ruDate(periodFrom)} — ${ruDate(defaultAccrualDate)})` : ''}.
              Её можно изменить вручную — правило отсечки при этом сохранится.
            </>
          ) : nextScheduledDate ? (
            <>
              В документ войдут начисления и окладные дни до этой даты
              включительно. Ближайшее начисление по расписанию —{' '}
              {ruDate(nextScheduledDate)}.
            </>
          ) : (
            'В документ войдут начисления и окладные дни до этой даты включительно.'
          )}
        </p>
      </div>

      <div className="admin-field">
        <label htmlFor="create-ad-employee">Сотрудник</label>
        <CreatableSelect
          entity="employee"
          id="create-ad-employee"
          name="employeeId"
          defaultValue=""
          existingValues={sortedEmployees.map((e) => e.id)}
        >
          <option value="">— все сотрудники —</option>
          {sortedEmployees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.fullName}
            </option>
          ))}
        </CreatableSelect>
        <p className="admin-hint">
          Оставьте «все сотрудники», чтобы начислить всем сразу, или выберите
          одного — документ сформируется только по нему.
        </p>
      </div>

      <div className="admin-field" style={{ gridColumn: '1 / -1' }}>
        <label htmlFor="create-ad-comment">Комментарий менеджера</label>
        <textarea
          id="create-ad-comment"
          name="managerComment"
          rows={3}
          placeholder="Необязательно"
        />
      </div>

      <div
        className="admin-field"
        style={{
          flexDirection: 'row',
          gap: '0.5rem',
          alignItems: 'flex-end',
          gridColumn: '1 / -1',
        }}
      >
        <SubmitButton />
      </div>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      {pending ? 'Формирование...' : 'Сформировать документ'}
    </button>
  );
}
