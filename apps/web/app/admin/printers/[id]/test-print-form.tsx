'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Send, XCircle } from 'lucide-react';
import { testPrintAction } from '../actions';
import { initialActionState, type ActionState } from '../form-state';

function TestButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Send size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Отправка…' : 'Печать'}
    </button>
  );
}

export function TestPrintForm({ printerId }: { printerId: string }) {
  const action = testPrintAction.bind(null, printerId);
  const [state, formAction] = useFormState<ActionState, FormData>(
    action,
    initialActionState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-actions-row" style={{ justifyContent: 'flex-start' }}>
        <TestButton />
      </div>
      {state.error && (
        <div
          role="alert"
          style={{ color: 'var(--admin-danger-fg)', fontSize: '0.88rem' }}
        >
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && (
        <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
          Задание отправлено.
        </div>
      )}
    </form>
  );
}
