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
      <div className="form-row">
        <label htmlFor="maxQty">Лимит, шт.</label>
        <div>
          <input
            id="maxQty"
            name="maxQty"
            type="number"
            min={1}
            max={100}
            step={1}
            placeholder="100"
            disabled={disabled}
          />
          <div className="hint">
            Можно оставить пустым — будет 100 (стандарт MVP).
          </div>
        </div>
      </div>
      <div className="actions-row">
        <SubmitButton disabled={disabled} />
      </div>
    </form>
  );
}
