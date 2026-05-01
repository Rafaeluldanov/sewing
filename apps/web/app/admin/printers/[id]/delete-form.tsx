'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Icon } from '@/components/icon';
import { deletePrinterAction } from '../actions';
import { initialActionState, type ActionState } from '../form-state';

function DeleteButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-secondary"
      disabled={pending}
      onClick={(e) => {
        if (!confirm('Удалить принтер вместе с историей печати?')) {
          e.preventDefault();
        }
      }}
    >
      <Icon name="reset" size={16} />
      {pending ? 'Удаляем…' : 'Удалить принтер'}
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
    <form action={formAction} className="detail-form">
      {state.error && (
        <div className="detail-form__error" role="alert">
          <Icon name="error" size={16} />
          <span>{state.error}</span>
        </div>
      )}
      <div className="detail-form__actions">
        <DeleteButton />
      </div>
    </form>
  );
}
