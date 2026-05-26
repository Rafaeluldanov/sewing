'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { createBoxAction } from './actions';
import { initialPackingFormState } from './form-state';

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary"
      disabled={pending || disabled}
    >
      {pending ? 'Создаём…' : 'Создать коробку'}
    </button>
  );
}

export function CreateBoxForm({ disabled = false }: { disabled?: boolean }) {
  const [state, formAction] = useFormState(
    createBoxAction,
    initialPackingFormState,
  );
  return (
    <form action={formAction}>
      {state.error && <div className="error-box">{state.error}</div>}
      {state.info && <div className="info-box">{state.info}</div>}
      <div className="actions-row">
        <SubmitButton disabled={disabled} />
      </div>
    </form>
  );
}
