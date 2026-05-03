'use client';

/**
 * Клиентская форма создания документа начисления зарплаты.
 * Требует 'use client' для `useFormState` / `useFormStatus`.
 *
 * Страница-обёртка (`new/page.tsx`) — RSC.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { createPayrollAccrualDocumentAction } from '../actions';
import type { AccrualDocumentActionState } from '../actions';

const initialState: AccrualDocumentActionState = {};

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function CreateAccrualDocumentForm() {
  const [state, formAction] = useFormState(
    createPayrollAccrualDocumentAction,
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

      <div className="admin-field">
        <label htmlFor="create-ad-date">Дата начисления *</label>
        <input
          id="create-ad-date"
          type="date"
          name="accrualDate"
          required
          defaultValue={todayIso()}
        />
        <p className="admin-hint">
          В документ войдут начисления и окладные дни до этой даты включительно.
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
