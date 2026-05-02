'use client';

/**
 * Клиентская форма создания выплаты. Требует 'use client' для
 * `useFormState` / `useFormStatus` (отображение ошибок и pending).
 *
 * Страница-обёртка (`new/page.tsx`) — RSC, она загружает список
 * сотрудников и пробрасывает в этот компонент.
 */

import { useFormState, useFormStatus } from 'react-dom';
import type { EmployeeListItemDto } from '@sewing/shared/employees';
import { createPayrollPayoutAction } from '../actions';
import type { PayrollPayoutActionState } from '../form-state';

const initialState: PayrollPayoutActionState = {};

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function monthStartIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

export function CreatePayrollPayoutForm({
  employees,
}: {
  employees: EmployeeListItemDto[];
}) {
  const [state, formAction] = useFormState(
    createPayrollPayoutAction,
    initialState,
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

      <div className="admin-field" style={{ gridColumn: '1 / -1' }}>
        <label htmlFor="create-payout-employee">Сотрудник *</label>
        <select
          id="create-payout-employee"
          name="employeeId"
          required
          defaultValue=""
        >
          <option value="" disabled>
            — выберите сотрудника —
          </option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.fullName}
            </option>
          ))}
        </select>
      </div>

      <div className="admin-field">
        <label htmlFor="create-payout-period-from">Период с *</label>
        <input
          id="create-payout-period-from"
          type="date"
          name="periodFrom"
          required
          defaultValue={monthStartIso()}
        />
      </div>

      <div className="admin-field">
        <label htmlFor="create-payout-period-to">По *</label>
        <input
          id="create-payout-period-to"
          type="date"
          name="periodTo"
          required
          defaultValue={todayIso()}
        />
      </div>

      <div className="admin-field" style={{ gridColumn: '1 / -1' }}>
        <label htmlFor="create-payout-comment">
          Комментарий менеджера
        </label>
        <textarea
          id="create-payout-comment"
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
      {pending ? 'Создание...' : 'Создать выплату'}
    </button>
  );
}
