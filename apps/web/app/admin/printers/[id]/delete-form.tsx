'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Trash2, XCircle } from 'lucide-react';
import { deletePrinterAction } from '../actions';
import { initialActionState, type ActionState } from '../form-state';

function DeleteButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--danger"
      disabled={pending}
      onClick={(e) => {
        if (!confirm('Удалить принтер вместе с историей печати?')) {
          e.preventDefault();
        }
      }}
    >
      <Trash2 size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Удаляем…' : 'Удалить'}
    </button>
  );
}

export function DeletePrinterForm({ printerId }: { printerId: string }) {
  const action = deletePrinterAction.bind(null, printerId);
  const [state, formAction] = useFormState<ActionState, FormData>(
    action,
    initialActionState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-actions-row" style={{ justifyContent: 'flex-start' }}>
        <DeleteButton />
      </div>
      {state.error && (
        <div
          role="alert"
          style={{ color: 'var(--admin-danger-fg)', fontSize: '0.88rem' }}
        >
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
    </form>
  );
}
